import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);
export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null;

export async function ensureAnonymousSession() {
  if (!supabase) return null;
  const existing = await supabase.auth.getSession();
  if (existing.data.session) return existing.data.session;
  const created = await supabase.auth.signInAnonymously();
  if (created.error) throw created.error;
  return created.data.session;
}
