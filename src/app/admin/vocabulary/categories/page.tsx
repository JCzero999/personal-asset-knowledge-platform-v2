import { VocabularyPage } from "@/components/vocabulary-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function VocabularyCategoriesPage() {
  return <VocabularyPage tab="categories" />;
}
