"""OpenAI 兼容的本地 embedding 服务，供 LightRAG 使用。

模型与 RAGFlow 共用同一份 bge-large-zh-v1.5 文件（ADR-001 / ADR-010）：
lightrag-server 只支持 OpenAI 兼容接口，因此这里用 sentence-transformers
把同一份模型包装成 /v1/embeddings。

启动：
    .venv/Scripts/python.exe -m uvicorn embedding_server:app --host 127.0.0.1 --port 9381
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
from starlette.concurrency import run_in_threadpool

DEFAULT_MODEL_DIR = Path(__file__).resolve().parent / "models" / "bge-large-zh-v1.5"
MODEL_DIR = Path(os.environ.get("EMBEDDING_MODEL_DIR", DEFAULT_MODEL_DIR))
MAX_BATCH = int(os.environ.get("EMBEDDING_MAX_BATCH", "64"))

app = FastAPI(title="pakp-local-embedding")
_model: SentenceTransformer | None = None


def get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        if not MODEL_DIR.is_dir():
            raise RuntimeError(f"embedding model directory not found: {MODEL_DIR}")
        _model = SentenceTransformer(str(MODEL_DIR), device="cpu")
    return _model


class EmbeddingRequest(BaseModel):
    model: str | None = None
    input: str | list[str]
    dimensions: int | None = None
    encoding_format: str | None = None


def _encode(texts: list[str], dimensions: int | None) -> list[list[float]]:
    vectors = get_model().encode(
        texts,
        normalize_embeddings=True,
        convert_to_numpy=True,
        batch_size=8,
        show_progress_bar=False,
    )
    if dimensions and dimensions != vectors.shape[1]:
        vectors = vectors[:, :dimensions]
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        vectors = vectors / np.clip(norms, 1e-12, None)
    return vectors.astype(float).tolist()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model_dir": str(MODEL_DIR),
        "model_loaded": _model is not None,
        "dimensions": None if _model is None else _model.get_sentence_embedding_dimension(),
    }


@app.get("/v1/models")
def models() -> dict:
    return {"object": "list", "data": [{"id": "bge-large-zh-v1.5", "object": "model"}]}


@app.post("/v1/embeddings")
async def embeddings(body: EmbeddingRequest) -> dict:
    texts = [body.input] if isinstance(body.input, str) else list(body.input)
    if not texts or any(not isinstance(t, str) or not t.strip() for t in texts):
        raise HTTPException(status_code=400, detail="input must be non-empty text")
    if len(texts) > MAX_BATCH:
        raise HTTPException(status_code=400, detail=f"at most {MAX_BATCH} inputs per request")

    vectors = await run_in_threadpool(_encode, texts, body.dimensions)
    return {
        "object": "list",
        "data": [
            {"object": "embedding", "index": i, "embedding": vector}
            for i, vector in enumerate(vectors)
        ],
        "model": body.model or "bge-large-zh-v1.5",
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    }
