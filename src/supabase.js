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

// ── Study groups (friends leaderboard) ────────────────────────────────────────
async function getUid() {
  if (!supabase) throw new Error('Database not configured');
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) throw new Error('Not signed in');
  return session.user.id;
}

export async function createStudyGroup(groupName) {
  const uid = await getUid();
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const { data, error } = await supabase
    .from('study_groups')
    .insert({ code, name: groupName.trim(), created_by: uid })
    .select().single();
  if (error) throw new Error(error.message);
  await supabase.from('group_members').insert({ group_id: data.id, user_id: uid });
  return data;
}

export async function joinStudyGroup(code) {
  const uid = await getUid();
  const { data: group, error } = await supabase
    .from('study_groups').select('*').eq('code', code.toUpperCase().trim()).maybeSingle();
  if (error || !group) throw new Error('Group not found — double-check the code');
  const { error: joinError } = await supabase
    .from('group_members').insert({ group_id: group.id, user_id: uid });
  if (joinError && !joinError.message?.includes('duplicate')) throw new Error(joinError.message);
  return group;
}

export async function getGroupLeaderboard() {
  if (!supabase) return null;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return null;
    const uid = session.user.id;
    const { data: membership } = await supabase
      .from('group_members').select('group_id').eq('user_id', uid).maybeSingle();
    if (!membership) return null;
    const [{ data: group }, { data: memberRows }] = await Promise.all([
      supabase.from('study_groups').select('id, name, code').eq('id', membership.group_id).single(),
      supabase.from('group_members').select('user_id').eq('group_id', membership.group_id),
    ]);
    const memberIds = (memberRows || []).map(r => r.user_id);
    const [{ data: profiles }, { data: progressRows }] = await Promise.all([
      supabase.from('profiles').select('id, name').in('id', memberIds),
      supabase.from('progress').select('user_id, lumora_xp, lumora_streak, lumora_weekly_stats').in('user_id', memberIds),
    ]);
    const members = (profiles || []).map(p => {
      const prog = (progressRows || []).find(r => r.user_id === p.id) || {};
      const totalXP = prog.lumora_xp?.total || 0;
      const weeklyXP = Math.max(0, totalXP - (prog.lumora_weekly_stats?.xpStart || totalXP));
      return { userId: p.id, name: p.name || 'Anonymous', totalXP, weeklyXP, streak: prog.lumora_streak?.current || 0, isMe: p.id === uid };
    }).sort((a, b) => b.weeklyXP - a.weeklyXP || b.totalXP - a.totalXP);
    return { group, members };
  } catch { return null; }
}

export async function leaveStudyGroup() {
  if (!supabase) return;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return;
  const user = session.user;
  const { data: membership } = await supabase
    .from('group_members').select('group_id').eq('user_id', user.id).maybeSingle();
  if (!membership) return;
  await supabase.from('group_members').delete()
    .eq('user_id', user.id).eq('group_id', membership.group_id);
}

export async function saveParentEmail(userId, parentEmail) {
  if (!supabase || !userId) return;
  await supabase.from('profiles').update({ parent_email: parentEmail }).eq('id', userId);
}
