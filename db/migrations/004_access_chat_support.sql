-- Learned from providers: an access path whose provider said it does not
-- serve chat completions (e.g. completions-only or Responses-API-only ids).
-- null = not yet known. Refresh never resets it; only a provider answer does.
alter table model_provider_access add column if not exists chat_supported boolean;
alter table model_provider_access add column if not exists chat_supported_detail text;
alter table model_provider_access add column if not exists chat_supported_checked_at timestamptz;
