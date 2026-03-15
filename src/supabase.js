import { createClient } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = URL && KEY ? createClient(URL, KEY) : null;

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function sbSignUp(email, password, profileData) {
  if (!supabase) throw new Error('Database not configured. Contact support.');
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(error.message);
  const user = data.user;
  if (user) {
    await supabase.from('profiles').upsert({
      id: user.id, email,
      name: profileData.name || '',
      board: profileData.board || 'AQA',
      grade: profileData.grade || '7',
      exam_date: profileData.examDate || '',
      weaknesses: profileData.weaknesses || [],
    });
  }
  return user;
}

export async function sbSignIn(email, password) {
  if (!supabase) throw new Error('Database not configured. Contact support.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data.user;
}

export async function sbSignOut() {
  await supabase?.auth.signOut();
}

export async function sbGetSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user || null;
}

// ── Progress sync ─────────────────────────────────────────────────────────────
const PROGRESS_KEYS = ['gcse_sr','gcse_perf','lumora_xp','lumora_streak','lumora_daily','lumora_weekly','lumora_weekly_stats'];

export async function loadProgressFromSupabase(userId) {
  if (!supabase) return;
  const { data } = await supabase.from('progress').select('*').eq('user_id', userId).single();
  if (!data) return;
  // Hydrate localStorage with Supabase data
  PROGRESS_KEYS.forEach(k => {
    if (data[k] !== undefined && data[k] !== null) {
      localStorage.setItem(`lumora_${userId}_${k}`, JSON.stringify(data[k]));
    }
  });
}

export async function saveProgressToSupabase(userId) {
  if (!supabase || !userId) return;
  const row = { user_id: userId, updated_at: new Date().toISOString() };
  PROGRESS_KEYS.forEach(k => {
    try {
      const raw = localStorage.getItem(`lumora_${userId}_${k}`);
      if (raw) row[k] = JSON.parse(raw);
    } catch(e) { void e; }
  });
  await supabase.from('progress').upsert(row);
}

// Debounced save — avoids hammering Supabase on every keystroke
let _saveTimer = null;
export function scheduleSave(userId) {
  if (!userId) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => saveProgressToSupabase(userId), 2000);
}
