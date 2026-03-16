-- ═══ RUN THIS IN YOUR SUPABASE SQL EDITOR ══════════════════════════════════
-- Dashboard → SQL Editor → New Query → paste this → Run

-- Friends leaderboard tables
CREATE TABLE IF NOT EXISTS study_groups (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  code varchar(6) UNIQUE NOT NULL,
  name varchar(50) NOT NULL,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id uuid REFERENCES study_groups(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  joined_at timestamptz DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

-- Parent email column
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS parent_email varchar(255);

-- Row Level Security
ALTER TABLE study_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;

-- Anyone can look up a group by code (needed to join)
CREATE POLICY "Anyone can look up groups by code" ON study_groups
  FOR SELECT USING (true);

-- Only authenticated users can create groups
CREATE POLICY "Authenticated users can create groups" ON study_groups
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND created_by = auth.uid());

-- Members can see other members in their group
CREATE POLICY "Members can view group members" ON group_members
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );

-- Authenticated users can join groups
CREATE POLICY "Authenticated users can join groups" ON group_members
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can leave groups
CREATE POLICY "Users can leave groups" ON group_members
  FOR DELETE USING (user_id = auth.uid());
