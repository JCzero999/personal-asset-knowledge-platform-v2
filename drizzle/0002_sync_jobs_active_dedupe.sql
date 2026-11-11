CREATE UNIQUE INDEX `sync_jobs_active_uq` ON `sync_jobs` (`owner_type`,`owner_id`,coalesce(`content_ref_id`, ''),`action`) WHERE state in ('pending', 'running');
