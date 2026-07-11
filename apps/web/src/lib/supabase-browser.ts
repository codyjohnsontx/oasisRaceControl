"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** Anon-key client for client components: realtime subscriptions and the
 * public leaderboard views. RLS limits what this can see. */
export function browserClient(): SupabaseClient {
  // NEXT_PUBLIC_* values are inlined at build time; must be referenced
  // statically for the bundler to substitute them.
  client ??= createClient(
    required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  );
  return client;
}
