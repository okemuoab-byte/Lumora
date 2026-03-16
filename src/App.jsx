import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Flame, Zap, Trophy, Target, Calendar, Check, X, Lightbulb, Sparkles, Info, MessageCircle, Volume2, VolumeX, Settings, AlertTriangle, GraduationCap, Rocket, BookOpen, FileText, Bot, BarChart2, TrendingUp, PenLine, Award, Snowflake, ClipboardList, Loader2, Share2, CheckCircle2, XCircle, BarChart, FlaskConical, Sigma, Users } from "lucide-react";
import { track, identify } from './analytics.js';
import { sbSignUp, sbSignIn, sbSignOut, sbGetSession, loadProgressFromSupabase, scheduleSave } from './supabase.js';

// ═══ STORAGE & AUTH ══════════════════════════════════════════════════════════
let _currentUser=null;// set on login/init — email string
let _currentUserId=null;// supabase user id (uuid)
const GLOBAL_KEYS=new Set(['lumora_users','lumora_currentUser','lumora_sound']);
function lsKey(k){return(!GLOBAL_KEYS.has(k)&&_currentUser)?`lumora_${_currentUser}_${k}`:k;}
function lsGet(k,d){try{const v=localStorage.getItem(lsKey(k));return v!=null?JSON.parse(v):d;}catch{return d;}}
function lsSet(k,v){localStorage.setItem(lsKey(k),JSON.stringify(v));scheduleSave(_currentUserId);}

function getCurrentUserEmail(){return localStorage.getItem('lumora_currentUser');}
function clearCurrentUser(){localStorage.removeItem('lumora_currentUser');_currentUser=null;_currentUserId=null;sbSignOut();}
function initCurrentUser(email,userId){
  _currentUser=email;
  _currentUserId=userId||null;
  localStorage.setItem('lumora_currentUser',email);
  migrateUnscopedData(email);
}
function migrateUnscopedData(email){
  ['gcse_sr','gcse_perf','lumora_profile','lumora_xp','lumora_streak',
   'lumora_daily','lumora_weekly','lumora_weekly_stats'].forEach(k=>{
    const raw=localStorage.getItem(k);
    const scoped=`lumora_${email}_${k}`;
    if(raw&&!localStorage.getItem(scoped)){localStorage.setItem(scoped,raw);}
  });
}

// ═══ GAMIFICATION ════════════════════════════════════════════════════════════
const LEVELS=[
  {name:'Bronze',min:0,max:199,icon:'🥉',color:'#CD7F32'},
  {name:'Silver',min:200,max:599,icon:'🥈',color:'#A8A9AD'},
  {name:'Gold',min:600,max:1299,icon:'🥇',color:'#D4A017'},
  {name:'Platinum',min:1300,max:Infinity,icon:'💎',color:'#7B68EE'},
];
function getLevel(xp){return LEVELS.find(l=>xp>=l.min&&xp<=l.max)||LEVELS[0];}
const LEVEL_ICON_MAP={Bronze:Award,Silver:Award,Gold:Trophy,Platinum:FlaskConical};
function LevelIcon({name,size=14,color}){const Icon=LEVEL_ICON_MAP[name]||Award;return<Icon size={size} color={color} strokeWidth={2}/>;}
function getXP(){return lsGet('lumora_xp',{total:0}).total;}
function addXP(amount){
  const d=lsGet('lumora_xp',{total:0});
  const old=getLevel(d.total);
  d.total+=amount;
  const nw=getLevel(d.total);
  lsSet('lumora_xp',d);
  return{total:d.total,levelUp:old.name!==nw.name,newLevel:nw};
}
function getStreakData(){return lsGet('lumora_streak',{current:0,lastDate:null,freezes:0,best:0});}
function touchStreak(){
  const d=lsGet('lumora_streak',{current:0,lastDate:null,freezes:0,best:0});
  const today=new Date().toDateString();
  const yest=new Date(Date.now()-86400000).toDateString();
  if(d.lastDate===today)return{streak:d.current,milestone:false};
  if(d.lastDate===yest){d.current++;}
  else if(d.freezes>0){d.freezes--;d.current++;}
  else{d.current=1;}
  d.lastDate=today;d.best=Math.max(d.best,d.current);
  let milestone=false;
  if(d.current>=5&&d.current%5===0){d.freezes++;milestone=true;}
  lsSet('lumora_streak',d);
  return{streak:d.current,milestone};
}

// ═══ DAILY CHALLENGE & WEEKLY GOAL ════════════════════════════════════════════
function todayStr(){return new Date().toISOString().slice(0,10);}
function setDailyDone(xp){lsSet('lumora_daily',{date:todayStr(),completed:true,xp});}
function getWeeklyData(){
  const today=new Date();const dow=(today.getDay()+6)%7;
  const mon=new Date(today);mon.setDate(today.getDate()-dow);
  const ws=mon.toISOString().slice(0,10);
  const d=lsGet('lumora_weekly',{weekStart:null,count:0});
  if(d.weekStart!==ws){const f={weekStart:ws,count:0};lsSet('lumora_weekly',f);return f;}
  return d;
}
function incrementWeekly(){const d=getWeeklyData();d.count=Math.min(7,d.count+1);lsSet('lumora_weekly',d);return d;}
function getWeakTopics(){
  const perf=lsGet('gcse_perf',{});
  const all=MODULES.flatMap(m=>m.topics);
  const scored=all.map(t=>{const p=perf[t.id];return{...t,score:p&&p.total>0?p.correct/p.total:null};});
  const weak=scored.filter(t=>t.score===null||t.score<0.7);
  return shuffle(weak.length>=3?weak:scored).slice(0,3);
}
function getFallbackDailyQs(){
  const starters=ALL_QUESTIONS.filter(q=>q.diff==='Starter');
  const mids=ALL_QUESTIONS.filter(q=>q.diff==='Mid');
  return[...shuffle(starters).slice(0,2),...shuffle(mids).slice(0,1)];
}
function getWeeklyStats(){
  const today=new Date();const dow=(today.getDay()+6)%7;
  const mon=new Date(today);mon.setDate(today.getDate()-dow);
  const ws=mon.toISOString().slice(0,10);
  const d=lsGet('lumora_weekly_stats',{weekStart:null,qCount:0,xpStart:0});
  if(d.weekStart!==ws){const f={weekStart:ws,qCount:0,xpStart:getXP()};lsSet('lumora_weekly_stats',f);return f;}
  return d;
}
function bumpWeeklyQs(){const d=getWeeklyStats();d.qCount++;lsSet('lumora_weekly_stats',d);}

function sm2Update(qid,quality){
  const data=lsGet('gcse_sr',{});
  const it=data[qid]||{ef:2.5,rep:0,interval:0};
  let{ef,rep,interval}=it;
  if(quality>=3){interval=rep===0?1:rep===1?6:Math.round(interval*ef);rep++;}
  else{rep=0;interval=1;}
  ef=Math.max(1.3,ef+0.1-(5-quality)*(0.08+(5-quality)*0.02));
  const next=new Date();next.setDate(next.getDate()+interval);
  data[qid]={ef,rep,interval,nextReview:next.toISOString()};
  lsSet('gcse_sr',data);
}
function getDueIds(){
  const data=lsGet('gcse_sr',{});
  const today=new Date();today.setHours(0,0,0,0);
  return Object.entries(data).filter(([,v])=>v.nextReview&&new Date(v.nextReview)<=today).map(([id])=>id);
}
function recordPerf(topicId,correct){
  const p=lsGet('gcse_perf',{});
  if(!p[topicId])p[topicId]={correct:0,total:0};
  p[topicId].total++;if(correct)p[topicId].correct++;lsSet('gcse_perf',p);
  bumpWeeklyQs();
}
// ═══ DESIGN SYSTEM ════════════════════════════════════════════════════════════
const DS={
  bg:{base:'#0E1117',surface:'#161B22',elevated:'#1C2128',overlay:'#21262D',deep:'#080C10'},
  accent:{
    amber:'#F5B700',amberDim:'rgba(245,183,0,0.10)',
    teal:'#00C9B1',tealDim:'rgba(0,201,177,0.10)',
    red:'#FF4C4C',redDim:'rgba(255,76,76,0.10)',
  },
  text:{primary:'#F0F6FC',secondary:'#8B949E',muted:'#484F58'},
  border:'rgba(255,255,255,0.08)',
  borderHi:'rgba(255,255,255,0.14)',
  radius:{sm:8,md:12,lg:16,xl:20},
  shadow:'0 4px 32px rgba(0,0,0,0.55)',
  tr:'all 0.22s ease',
};

function useIsMobile(){
  const [m,setM]=useState(()=>typeof window!=='undefined'&&window.innerWidth<640);
  useEffect(()=>{
    const h=()=>setM(window.innerWidth<640);
    window.addEventListener('resize',h,{passive:true});
    return()=>window.removeEventListener('resize',h);
  },[]);
  return m;
}

function heatColor(r){
  if(r===null)return{bg:DS.bg.elevated,c:DS.text.muted};
  if(r>=0.7)return{bg:DS.accent.tealDim,c:DS.accent.teal};
  if(r>=0.4)return{bg:DS.accent.amberDim,c:DS.accent.amber};
  return{bg:DS.accent.redDim,c:DS.accent.red};
}
function shuffle(arr){const a=[...arr];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

async function aiMark(question,marks,ms,working){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  if(!key)throw new Error('Add VITE_ANTHROPIC_API_KEY to .env.local to enable AI marking');
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:600,messages:[{role:'user',content:
      `You are a GCSE Maths examiner. Mark this student's answer.\nQUESTION (${marks} marks): ${question}\nMARK SCHEME:\n${ms.join('\n')}\nSTUDENT WORKING:\n${working||'(blank)'}\nReply ONLY with valid JSON (no markdown):\n{"marksEarned":0,"feedback":"what they got right","improvements":"what they missed","breakdown":["M1: earned/lost — reason"]}`
    }]})
  });
  if(!res.ok){const d=await res.json();throw new Error(d.error?.message||`HTTP ${res.status}`);}
  const d=await res.json();
  return JSON.parse(d.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
}

async function aiSocratic(question,ms,aiResult,chatHistory,maxMarks=0){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  if(!key)throw new Error('Add VITE_ANTHROPIC_API_KEY to .env.local');
  const gotFull=maxMarks>0?aiResult.marksEarned>=maxMarks:aiResult.marksEarned>=(aiResult.maxMarks??aiResult.totalMarks??999);
  const sys=`You are a Socratic maths tutor helping a GCSE student understand a question.

CONTEXT:
Question: ${question}
Mark scheme: ${ms.join(' | ')}
Student scored: ${aiResult.marksEarned} marks
What they got right: ${aiResult.feedback||'nothing noted'}
What they missed: ${aiResult.improvements||'N/A — full marks'}
Breakdown: ${aiResult.breakdown?.join(' | ')||''}

YOUR RULES:
- Respond with EXACTLY ONE short question — never give two
- NEVER state the answer, correct method, or formula directly
- Base your question on the specific gap identified above
- Lead the student to discover the answer through guided thinking
- ${gotFull?'They scored full marks — ask a stretching question that pushes understanding beyond this problem':'Focus on the exact mistake shown in the breakdown above'}
- Be warm and concise — one or two sentences maximum
- Reply ONLY with your question, no preamble and no sign-off`;
  const messages=chatHistory.length===0
    ?[{role:'user',content:'Start the dialogue. Ask your first Socratic question.'}]
    :chatHistory.map(m=>({role:m.from==='tutor'?'assistant':'user',content:m.text}));
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:150,system:sys,messages})
  });
  if(!res.ok){const d=await res.json();throw new Error(d.error?.message||`HTTP ${res.status}`);}
  const d=await res.json();
  return d.content.map(b=>b.text||'').join('').trim();
}

async function generateDailyQs(topics){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  if(!key)return null;
  const names=topics.map(t=>t.title).join(', ');
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:1600,messages:[{role:'user',content:
      `You are a GCSE Maths examiner. Generate exactly 3 questions covering: ${names}.\nMake 2 Starter (1-2 marks, direct single-step) and 1 Mid (3-4 marks, multi-step).\nReply ONLY with valid JSON (no markdown fences):\n{"questions":[{"q":"Full question text","marks":2,"diff":"Starter","ms":["M1: ...","A1: ..."],"insight":"key examiner tip"}]}`
    }]})
  });
  if(!res.ok)return null;
  const d=await res.json();
  return JSON.parse(d.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
}

async function generateTopicQs(topicTitle,moduleLabel,board,diffMix){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  if(!key)throw new Error('Add VITE_ANTHROPIC_API_KEY to .env.local');
  const boardStyle={
    AQA:'Multi-step worded problems. Reward method marks at each step. Show all working.',
    Edexcel:'Real-world applied context. "Evaluate and justify" questions. Formulae may not be given.',
    'Edexcel IGCSE':'Edexcel IGCSE (4MA1) style. Two papers: 1H non-calculator and 2H calculator. Set notation and proof prominent at Higher. Functions and calculus appear on Higher paper only. Real-world applied contexts. Show all working for method marks.',
    OCR:'Give a reason for each step. "Show that" and proof components. Justify all decisions.'
  };
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:1800,messages:[{role:'user',content:
      `You are a GCSE Maths examiner. Generate exactly 3 ${board} exam questions.\nTopic: ${topicTitle} (${moduleLabel})\nDifficulty mix: ${diffMix}\n${boardStyle[board]||boardStyle.AQA}\nReply ONLY with valid JSON (no markdown fences):\n{"questions":[{"q":"Full question text","marks":3,"diff":"Mid","ms":["M1: ...","A1: ..."],"insight":"examiner tip for this question"}]}`
    }]})
  });
  if(!res.ok){const d=await res.json();throw new Error(d.error?.message||`HTTP ${res.status}`);}
  const d=await res.json();
  return JSON.parse(d.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
}

async function aiMCQ(topicTitle,moduleLabel){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  if(!key)throw new Error('Add VITE_ANTHROPIC_API_KEY to .env.local');
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:1400,messages:[{role:'user',content:
      `Create 4 multiple-choice questions testing GCSE Maths understanding of: ${topicTitle} (${moduleLabel}).\nEach question must have 4 options (A–D), one correct answer, and three plausible distractors that reflect common misconceptions.\nReply ONLY with valid JSON (no markdown fences):\n{"questions":[{"q":"question text","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"brief explanation of why A is correct and why others are wrong"}]}`
    }]})
  });
  if(!res.ok){const d=await res.json();throw new Error(d.error?.message||`HTTP ${res.status}`);}
  const d=await res.json();
  return JSON.parse(d.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
}

async function aiWorkedSteps(topicTitle,sampleQ){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  if(!key)throw new Error('Add VITE_ANTHROPIC_API_KEY to .env.local');
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:1000,messages:[{role:'user',content:
      `Create a step-by-step worked example for GCSE Maths topic: ${topicTitle}.\nBase it on: ${sampleQ}\nBreak the solution into 4-6 clear numbered steps. Each step should explain WHAT to do and WHY it matters.\nReply ONLY with valid JSON (no markdown fences):\n{"problem":"full question text","steps":[{"number":1,"what":"what to do in this step","why":"why this step matters","result":"what you get at the end of this step"}]}`
    }]})
  });
  if(!res.ok){const d=await res.json();throw new Error(d.error?.message||`HTTP ${res.status}`);}
  const d=await res.json();
  return JSON.parse(d.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
}

async function aiExplainMark(topicTitle,explanation){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  if(!key)throw new Error('Add VITE_ANTHROPIC_API_KEY to .env.local');
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:500,messages:[{role:'user',content:
      `A GCSE student is explaining the maths topic "${topicTitle}" in their own words:\n"${explanation}"\nAssess their conceptual understanding. Be warm and encouraging.\nReply ONLY with valid JSON (no markdown fences):\n{"score":4,"correct":"what they understood well","missing":"key concepts not mentioned","tip":"one specific concept or phrase to add next time","encouragement":"one warm motivating sentence"}`
    }]})
  });
  if(!res.ok){const d=await res.json();throw new Error(d.error?.message||`HTTP ${res.status}`);}
  const d=await res.json();
  return JSON.parse(d.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
}

async function aiVisualDiagram(topicTitle,moduleLabel){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  if(!key)throw new Error('Add VITE_ANTHROPIC_API_KEY to .env.local');
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:1500,messages:[{role:'user',content:
      `Create a visual text diagram to explain the GCSE Maths concept: ${topicTitle} (${moduleLabel}).\nUse Unicode box-drawing characters (─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼), arrows (→ ← ↑ ↓ ⟶), and spacing to build a clear ASCII-style diagram.\nThe diagram should visually represent HOW the calculation or concept works — like a number line, flowchart, formula breakdown, comparison table, or step grid.\nKEEP THE DIAGRAM CONCISE — max 20 lines, max 60 characters wide. Quality over quantity.\nReply ONLY with valid JSON (no markdown fences). Escape all special characters in strings properly:\n{"title":"diagram title","diagram":"line1\\nline2\\nline3","callouts":["annotation 1","annotation 2"],"insight":"one sentence on what the visual reveals about the concept"}`
    }]})
  });
  if(!res.ok){const d=await res.json();throw new Error(d.error?.message||`HTTP ${res.status}`);}
  const d=await res.json();
  const raw=d.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();
  try{return JSON.parse(raw);}
  catch{throw new Error('Diagram response was cut off — please try again');}
}

async function aiErrorHunt(topicTitle,sampleQ){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  if(!key)throw new Error('Add VITE_ANTHROPIC_API_KEY to .env.local');
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:1200,messages:[{role:'user',content:
      `Create an "Error Hunt" exercise for GCSE Maths topic: ${topicTitle}.\nWrite a 5–7 step worked solution to this question: ${sampleQ}\nEmbed exactly 2 deliberate mistakes into the steps — the kind of errors students commonly make (wrong formula, arithmetic slip, wrong direction of inequality, etc.).\nDo NOT indicate which steps are wrong in the step text itself.\nReply ONLY with valid JSON (no markdown fences):\n{"question":"the problem","steps":[{"n":1,"text":"the working shown for this step"}],"errors":[{"stepNum":3,"error":"what the mistake is","correction":"what it should say"}],"tip":"general examiner advice for this type of question"}`
    }]})
  });
  if(!res.ok){const d=await res.json();throw new Error(d.error?.message||`HTTP ${res.status}`);}
  const d=await res.json();
  return JSON.parse(d.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
}

async function aiRealWorld(topicTitle,moduleLabel){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  if(!key)throw new Error('Add VITE_ANTHROPIC_API_KEY to .env.local');
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:900,messages:[{role:'user',content:
      `Create a compelling real-world story problem for GCSE Maths topic: ${topicTitle} (${moduleLabel}).\nPick an engaging context a teenager would find interesting: gaming, music production, sports analytics, social media, architecture, food, space, film — something unexpected and cool.\nMake the maths feel genuinely necessary, not forced.\nReply ONLY with valid JSON (no markdown fences):\n{"hook":"one punchy opening sentence with an emoji that grabs attention","context":"2-3 sentence real-world scenario narrative","question":"the maths question arising from this scenario","solution":"step-by-step solution written in the language of the scenario (reference the real-world context in each step)","connection":"one sentence explicitly linking back to the GCSE topic"}`
    }]})
  });
  if(!res.ok){const d=await res.json();throw new Error(d.error?.message||`HTTP ${res.status}`);}
  const d=await res.json();
  return JSON.parse(d.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
}

// ═══ PROGRESS REPORT ═════════════════════════════════════════════════════════
async function aiProgressReport({name,grade,avgPct,strongestTopic,strongestPct,weakestTopic,weakestPct,totalQs,board}){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  const fallback={
    summary:`${name||'Your child'} has been actively revising GCSE Maths on Lumora, currently achieving a predicted ${grade||'grade to be determined'} with ${avgPct}% average accuracy across ${totalQs} questions answered. Their strongest performance is in ${strongestTopic} (${strongestPct}%), showing solid understanding of this area. The main opportunity for grade improvement lies in ${weakestTopic} (${weakestPct}%), where targeted practice could make a meaningful difference.`,
    actions:[
      `Focus revision sessions on ${weakestTopic} — work through mark schemes step by step to understand where marks are lost`,
      `Set a target of 5 practice questions per day on Lumora to build consistent exam stamina`,
      `After each question, read the examiner feedback carefully and re-attempt any question scored below 60%`
    ]
  };
  if(!key)return fallback;
  try{
    const res=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
      body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:600,messages:[{role:'user',content:
        `Write a 3-sentence progress summary for a parent about their child's GCSE Maths revision. Student name: ${name||'the student'}. Predicted grade: ${grade||'not yet determined'}. Strongest topic: ${strongestTopic} at ${strongestPct}%. Weakest topic: ${weakestTopic} at ${weakestPct}%. Questions answered: ${totalQs}. Be encouraging but honest. One paragraph only, no bullet points.\n\nAlso write 3 specific action points to improve their grade on the ${board||'GCSE'} course. Reference specific topic names and techniques.\n\nReply ONLY with valid JSON (no markdown fences):\n{"summary":"paragraph here","actions":["specific action 1","specific action 2","specific action 3"]}`
      }]})
    });
    if(!res.ok)return fallback;
    const d=await res.json();
    return JSON.parse(d.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
  }catch{return fallback;}
}

function buildReportHTML({profile,grade,avgPct,totalQs,totalCorrect,streakCount,timeMinutes,strengths,weaknesses,aiSummary,aiActions,days}){
  const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const date=new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const name=esc(profile?.name||'Student');
  const board=esc(profile?.board||'GCSE');
  const tier=esc(profile?.tier||'');
  const accuracy=totalQs>0?Math.round((totalCorrect/totalQs)*100):0;
  const gradeNum=parseInt(String(grade||'').replace(/\D/g,''))||0;
  const gradeHex=gradeNum>=7?'#0d9488':gradeNum>=5?'#b87d0e':'#dc2626';
  const hrsStudied=Math.round(timeMinutes/60);

  const topicRow=(t,color)=>`
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px">
      <div style="font-family:'Segoe UI',sans-serif;font-size:12px;color:#2d3748;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</div>
      <div style="width:70px;height:5px;background:#e2e8f0;border-radius:3px;overflow:hidden;flex-shrink:0"><div style="height:100%;border-radius:3px;background:${color};width:${Math.round(t.score*100)}%"></div></div>
      <div style="font-family:'Segoe UI',sans-serif;font-size:12px;font-weight:800;color:${color};width:34px;text-align:right;flex-shrink:0">${Math.round(t.score*100)}%</div>
    </div>`;

  const strengthRows=strengths.length?strengths.map(t=>topicRow(t,'#0d9488')).join(''):'<div style="color:#718096;font-size:13px;font-family:\'Segoe UI\',sans-serif">Answer more questions to reveal strengths</div>';
  const weakRows=weaknesses.length?weaknesses.map(t=>topicRow(t,'#d97706')).join(''):'<div style="color:#718096;font-size:13px;font-family:\'Segoe UI\',sans-serif">Complete more topics to identify areas</div>';
  const actionItems=aiActions.map(a=>`<li>${esc(a)}</li>`).join('');

  return`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lumora Progress Report — ${name}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Georgia,'Times New Roman',serif;background:#f0ede8;color:#1a2744;font-size:14px;line-height:1.6}
.page{max-width:820px;margin:0 auto;background:#fff;box-shadow:0 0 60px rgba(0,0,0,0.15)}
.header{background:#1a2744;color:#fff;padding:28px 36px 24px}
.hdr-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
.logo{font-family:'Segoe UI',sans-serif;font-size:20px;font-weight:900;color:#C9941A}
.logo span{color:rgba(255,255,255,0.6);font-weight:400}
.hdr-date{font-size:11px;color:rgba(255,255,255,0.45);text-align:right;font-family:'Segoe UI',sans-serif}
.report-name{font-size:30px;font-weight:900;color:#fff;font-family:'Segoe UI',sans-serif;margin-bottom:3px}
.report-sub{font-size:14px;color:rgba(255,255,255,0.65);font-family:'Segoe UI',sans-serif}
.exam-badge{display:inline-block;background:rgba(201,148,26,0.2);border:1px solid rgba(201,148,26,0.45);color:#C9941A;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;font-family:'Segoe UI',sans-serif;margin-top:10px}
.grade-band{background:#13203a;padding:0 36px 28px;display:flex;align-items:flex-end;gap:24px}
.grade-box{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:20px 30px;text-align:center;flex-shrink:0}
.grade-num{font-family:'Segoe UI',sans-serif;font-size:76px;font-weight:900;line-height:1;color:${gradeHex}}
.grade-lbl{font-family:'Segoe UI',sans-serif;font-size:10px;font-weight:800;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:1.5px;margin-top:4px}
.grade-ctx{color:rgba(255,255,255,0.8);font-size:14px;font-family:'Segoe UI',sans-serif;padding-bottom:4px}
.grade-ctx p{margin-bottom:6px}
.big-acc{font-size:24px;font-weight:900;color:#C9941A;font-family:'Segoe UI',sans-serif}
.body{padding:32px 36px}
section{margin-bottom:28px}
.sec-title{font-family:'Segoe UI',sans-serif;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:1.8px;color:#1a2744;margin-bottom:14px;padding-bottom:7px;border-bottom:2.5px solid #C9941A;display:inline-block}
.ai-para{background:#fdfbf4;border-left:4px solid #C9941A;padding:18px 20px;border-radius:0 8px 8px 0;font-size:15px;line-height:1.85;color:#2d3748;font-style:italic}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px}
.stat{background:#f7f8fc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 12px;text-align:center}
.stat-v{font-family:'Segoe UI',sans-serif;font-size:28px;font-weight:900;color:#1a2744;line-height:1}
.stat-l{font-family:'Segoe UI',sans-serif;font-size:10px;color:#718096;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px}
.panel{background:#f7f8fc;border:1px solid #e2e8f0;border-radius:10px;padding:16px}
.panel-title{font-family:'Segoe UI',sans-serif;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
.acts{list-style:none;counter-reset:li;display:flex;flex-direction:column;gap:10px}
.acts li{counter-increment:li;display:flex;gap:12px;align-items:flex-start;background:#f7f8fc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;font-family:'Segoe UI',sans-serif;font-size:14px;color:#2d3748}
.acts li::before{content:counter(li);display:flex;align-items:center;justify-content:center;width:22px;height:22px;min-width:22px;background:#1a2744;color:#C9941A;border-radius:50%;font-size:11px;font-weight:900;font-family:'Segoe UI',sans-serif;flex-shrink:0;margin-top:1px}
.footer{background:#1a2744;color:rgba(255,255,255,0.45);padding:16px 36px;font-family:'Segoe UI',sans-serif;font-size:11px;display:flex;justify-content:space-between;align-items:center}
.footer-logo{color:#C9941A;font-weight:800}
.print-btn{display:flex;gap:10px;margin-bottom:24px}
@media print{
  body{background:#fff}
  .page{box-shadow:none;max-width:none}
  .print-btn{display:none!important}
  @page{margin:15mm;size:A4}
  .grade-band,.header,.footer{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  section,.two,.stats{page-break-inside:avoid}
}
</style>
</head>
<body>
<div class="page">
  <header class="header">
    <div class="hdr-top">
      <div class="logo">📐 Lumora <span>· Progress Report</span></div>
      <div class="hdr-date">Generated ${date}</div>
    </div>
    <div class="report-name">${name}</div>
    <div class="report-sub">${board} Maths${tier?' · '+tier:''}</div>
    ${days!==null?`<div class="exam-badge">📅 ${days} days until exam</div>`:''}
  </header>

  <div class="grade-band">
    <div class="grade-box">
      <div class="grade-num">${grade||'—'}</div>
      <div class="grade-lbl">Predicted Grade</div>
    </div>
    <div class="grade-ctx">
      <p><span class="big-acc">${avgPct!==null?avgPct+'%':'—'}</span> overall accuracy</p>
      <p>${totalQs} questions answered &nbsp;·&nbsp; ~${hrsStudied}h estimated revision</p>
      ${accuracy>=60?`<p style="color:#C9941A;font-weight:700">On track for Grade ${grade} ✓</p>`:'<p style="color:rgba(255,255,255,0.5)">Keep practising to strengthen grade prediction</p>'}
    </div>
  </div>

  <div class="body">
    <div class="print-btn">
      <button onclick="window.print()" style="padding:10px 20px;background:#1a2744;color:#C9941A;border:none;border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;font-family:'Segoe UI',sans-serif">🖨 Print / Save as PDF</button>
    </div>

    <section>
      <div class="sec-title">Progress Summary</div>
      <div class="ai-para">${esc(aiSummary)}</div>
    </section>

    <div class="stats">
      <div class="stat"><div class="stat-v">${totalQs}</div><div class="stat-l">Questions Answered</div></div>
      <div class="stat"><div class="stat-v">${accuracy}%</div><div class="stat-l">Overall Accuracy</div></div>
      <div class="stat"><div class="stat-v">${streakCount}</div><div class="stat-l">Day Streak</div></div>
      <div class="stat"><div class="stat-v">${hrsStudied>0?hrsStudied+'h':'<1h'}</div><div class="stat-l">Est. Study Time</div></div>
    </div>

    <div class="two">
      <div class="panel">
        <div class="panel-title" style="color:#0d9488">✓ Top Strengths</div>
        ${strengthRows}
      </div>
      <div class="panel">
        <div class="panel-title" style="color:#d97706">⚠ Areas to Improve</div>
        ${weakRows}
      </div>
    </div>

    <section>
      <div class="sec-title">What to do next</div>
      <ol class="acts">${actionItems}</ol>
    </section>
  </div>

  <footer class="footer">
    <div><span class="footer-logo">📐 Lumora</span> · GCSE Maths Revision Platform</div>
    <div>🔒 Data stored on this device only</div>
  </footer>
</div>
</body>
</html>`;
}

// ═══ SOCRATIC CHAT ═══════════════════════════════════════════════════════════
function SocraticChat({question,ms,aiResult,maxMarks=0}){
  const [messages,setMessages]=useState([]);
  const [input,setInput]=useState('');
  const [loading,setLoading]=useState(false);
  const bottomRef=useRef(null);

  useEffect(()=>{
    track('socratic_chat_opened');
    setLoading(true);
    aiSocratic(question,ms,aiResult,[],maxMarks)
      .then(text=>setMessages([{from:'tutor',text}]))
      .catch(e=>setMessages([{from:'tutor',text:'Could not start: '+e.message}]))
      .finally(()=>setLoading(false));
  },[]);

  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:'smooth'});},[messages,loading]);

  const handleSend=async()=>{
    if(!input.trim()||loading)return;
    const newMsg={from:'student',text:input.trim()};
    const updated=[...messages,newMsg];
    setMessages(updated);setInput('');setLoading(true);
    try{const text=await aiSocratic(question,ms,aiResult,updated,maxMarks);setMessages(m=>[...m,{from:'tutor',text}]);}
    catch(e){setMessages(m=>[...m,{from:'tutor',text:'Error: '+e.message}]);}
    setLoading(false);
  };

  return(
    <div style={{marginTop:14,borderTop:`1px solid ${DS.border}`,paddingTop:12}}>
      <div style={{fontSize:10,fontWeight:800,color:DS.accent.teal,textTransform:'uppercase',letterSpacing:1.5,marginBottom:10}}>Socratic Tutor</div>
      <div style={{maxHeight:260,overflowY:'auto',display:'flex',flexDirection:'column',gap:6,marginBottom:10}}>
        {loading&&messages.length===0&&(
          <div style={{background:DS.bg.elevated,borderLeft:`3px solid ${DS.accent.teal}`,borderRadius:`0 ${DS.radius.sm}px ${DS.radius.sm}px 0`,padding:'8px 12px',fontSize:13,color:DS.text.muted,fontStyle:'italic'}}>Preparing your question…</div>
        )}
        {messages.map((m,i)=>(
          <div key={i} style={{display:'flex',flexDirection:'column',alignItems:m.from==='tutor'?'flex-start':'flex-end'}}>
            <div style={{fontSize:9,fontWeight:800,color:m.from==='tutor'?DS.accent.teal:DS.accent.amber,marginBottom:2,paddingLeft:m.from==='tutor'?4:0,paddingRight:m.from==='student'?4:0}}>{m.from==='tutor'?'TUTOR':'YOU'}</div>
            <div style={{
              background:m.from==='tutor'?DS.bg.elevated:DS.bg.surface,
              borderLeft:m.from==='tutor'?`3px solid ${DS.accent.teal}`:'none',
              borderRight:m.from==='student'?`3px solid ${DS.accent.amber}`:'none',
              borderRadius:DS.radius.sm,padding:'8px 12px',fontSize:13,
              color:DS.text.primary,maxWidth:'85%',lineHeight:1.6
            }}>{m.text}</div>
          </div>
        ))}
        {loading&&messages.length>0&&(
          <div style={{background:DS.bg.elevated,borderLeft:`3px solid ${DS.accent.teal}`,borderRadius:`0 ${DS.radius.sm}px ${DS.radius.sm}px 0`,padding:'8px 12px',fontSize:13,color:DS.text.muted,fontStyle:'italic'}}>Thinking…</div>
        )}
        <div ref={bottomRef}/>
      </div>
      <div style={{display:'flex',gap:8}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&handleSend()} placeholder="Type your response and press Enter…" disabled={loading}
          style={{flex:1,padding:'8px 12px',borderRadius:DS.radius.sm,border:`1.5px solid ${DS.border}`,fontSize:13,fontFamily:'inherit',outline:'none',background:DS.bg.elevated,color:DS.text.primary}}
          onFocus={e=>e.target.style.borderColor=DS.accent.amber} onBlur={e=>e.target.style.borderColor=DS.border}/>
        <button onClick={handleSend} disabled={loading||!input.trim()} style={{padding:'8px 14px',borderRadius:DS.radius.sm,border:'none',background:loading||!input.trim()?DS.bg.overlay:DS.accent.amber,color:loading||!input.trim()?DS.text.muted:DS.bg.base,fontWeight:800,fontSize:14,cursor:loading||!input.trim()?'not-allowed':'pointer',transition:DS.tr}}>→</button>
      </div>
    </div>
  );
}

// ═══ DATA ════════════════════════════════════════════════════════════════════
const MODULES=[
  {id:1,code:"M1",label:"Number",color:"#E8B84B",icon:"⬡",topics:[
    {id:"1.1",title:"Place Value, Ordering & Rounding",
      boards:{AQA:"Direct: 'Round 0.007462 to 2 s.f.' Expects answer clearly shown. Upper/lower bounds use < not ≤.",Edexcel:"Context-based: 'Give your answer to an appropriate degree of accuracy'. Bounds: compute max/min of A÷B.",OCR:"Justify rounding: 'Explain why 3 s.f. is appropriate'. Error intervals as a ≤ x < b.",'Edexcel IGCSE':"Same as Edexcel. Error intervals use ≤ x < notation. Paper 1H (non-calc): bounds and significant figures without a calculator. 'Appropriate degree of accuracy' = match the precision of given data."},
      analogy:{icon:"🪨",title:"The Cliff Edge Rule",lines:["A ball rolls toward a cliff edge — the next digit decides its fate.","5 or more → ball goes OVER → round UP.","0–4 → ball rolls BACK → round DOWN.","Significant figures: count from the FIRST NON-ZERO digit.","0.00741 to 1 s.f. → first non-zero is 7 → answer: 0.007"]},
      markScheme:["B marks: correct answer regardless of method","M marks: method correct, even if arithmetic wrong","A marks: accuracy, only awarded after M mark earned","Upper bound: always < (strict), never ≤","Show all working — examiners award marks for correct steps"],
      questions:[
        {q:"Write 0.045678 correct to 2 significant figures.",marks:1,diff:"Starter",ms:["B1 for 0.046","Error: 0.045 (rounded wrong) = 0 marks"],insight:"1st s.f.=4, 2nd=5. Next digit is 6 ≥ 5 so round up. Never add trailing zeros unless instructed."},
        {q:"A = 7.3 cm measured to 1 d.p. Write down the error interval for A.",marks:2,diff:"Mid",ms:["M1: upper bound=7.35, lower=7.25","A1: 7.25 ≤ A < 7.35  (strict inequality at top)"],insight:"Like a doorstep — could be anywhere from 7.25 up to but NOT including 7.35."},
        {q:"Rectangle: length 8.4 cm, width 3.7 cm (both to nearest mm). Find MAXIMUM possible area to 3 s.f.",marks:4,diff:"Killer",ms:["M1: Upper bound L = 8.45","M1: Upper bound W = 3.75","M1: 8.45 × 3.75","A1: 31.7 cm²"],insight:"Maximum area needs BOTH dimensions at maximum. Using 8.4 × 3.7 loses all 4 marks."}
      ],
      mistakes:["Rounding 2.545 to 2 d.p. → 2.54 instead of 2.55","Counting s.f. from the decimal point, not the first non-zero digit","Writing ≤ 8.45 instead of < 8.45 for the upper bound","On Edexcel: 'appropriate accuracy' = match the data precision given"]
    },
    {id:"1.2",title:"Fractions",
      boards:{AQA:"Mixed numbers: '2¾ + 1⅖' — show common denominator for M mark. Simplest form required when stated.",Edexcel:"Embedded in context. Algebraic fractions at Higher. 'Simplest form' in question = must simplify or lose A mark.",OCR:"'Show that' — prove with full working. Fraction division in context."},
      analogy:{icon:"🍕",title:"The Pizza Factory",lines:["The denominator = how many slices the pizza is cut into.","You CANNOT add slices from different-sized pizzas. Recut first (common denominator).","ADDING: ⅓ + ¼ → 12ths: 4/12 + 3/12 = 7/12","MULTIPLYING: ⅓ × ¼ = 1/12  (just multiply straight across)","DIVIDING: KFC — Keep, Flip, Change (÷ becomes ×)"]},
      markScheme:["M1 for correct common denominator seen","Mixed numbers: convert to improper FIRST or lose M marks","'Simplest form': unsimplified loses final A mark","'Show that': every step visible, no shortcuts","Correct unsimplified often earns full marks on AQA"],
      questions:[
        {q:"Work out  2¾ + 1⅗.  Give your answer as a mixed number in its simplest form.",marks:3,diff:"Starter",ms:["M1: Improper fractions: 11/4 and 8/5","M1: Common denominator 20: 55/20 + 32/20 = 87/20","A1: 4 7/20"],insight:"Never add as '2+1 then ¾+⅗'. Convert to improper first — that's where the M mark lives."},
        {q:"Without a calculator, work out  3½ ÷ 1¾.  Show all working.",marks:3,diff:"Mid",ms:["M1: 7/2 and 7/4","M1: KFC: 7/2 × 4/7","A1: 2"],insight:"Cancel BEFORE multiplying — the 7s cancel and 4/2 simplifies. Shows mathematical elegance examiners reward."},
        {q:"⅗ of a class study French. ¾ of those also study Spanish. Show that the fraction studying BOTH is 45%.",marks:4,diff:"Killer",ms:["M1: ⅗ × ¾ = 9/20","A1: 9/20","M1: ×100","A1: 45% — must show the ×100 step"],insight:"Answer is given — job is the JOURNEY. Writing 9/20 = 45% without showing ×100 earns only 2/4."}
      ],
      mistakes:["Adding denominators: ⅓ + ¼ = 2/7  ✗","Forgetting to simplify when asked","Dividing mixed numbers without converting to improper","'Show that': final answer only = ZERO marks"]
    },
    {id:"1.3",title:"Percentages",
      boards:{AQA:"Multi-step: £320 reduced by 15%. Reverse % clearly stated. Compound interest formula on formula sheet.",Edexcel:"Multiplier method expected. Applied VAT/sale contexts. Formula NOT always provided — must recall.",OCR:"Reverse % in context. 'Explain your method'. May require justification of comparison."},
      analogy:{icon:"🔢",title:"The Multiplier — One Tool for Everything",lines:["BUILD the change INTO the multiplication:","Increase by 15%  →  × 1.15   (keep 100%, add 15%)","Decrease by 15%  →  × 0.85   (keep 100%, lose 15%)","Compound 3 years at 4%  →  × 1.04³","REVERSE: already have result — DIVIDE by the multiplier","After 20% increase = £84 → original = £84 ÷ 1.20 = £70"]},
      markScheme:["M1 for correct multiplier (0.85, 1.15) even if calculation wrong","Compound: M1 multiplier + M1 power + A1 answer","Reverse: M1 for dividing by multiplier — NOT subtracting %","'Evaluate' questions: marks split between calculation AND verdict"],
      questions:[
        {q:"A jacket costs £85. In a sale the price is reduced by 35%. What is the sale price?",marks:2,diff:"Starter",ms:["M1: 85 × 0.65","A1: £55.25"],insight:"Show 0.65 explicitly — that's the M mark. Wrong arithmetic still earns M1 if method is right."},
        {q:"A car bought for £12,000 depreciates by 18% per year. Find its value after 3 years.",marks:3,diff:"Mid",ms:["M1: Multiplier = 0.82","M1: 12000 × 0.82³","A1: £6,634"],insight:"Never subtract 18% three times — wrong each time. The ³ is everything. Edexcel may not provide this formula."},
        {q:"After a 24% increase a ticket costs £37.20. Sienna says the increase was £8.93. Is she correct? Justify.",marks:4,diff:"Killer",ms:["M1: 37.20 ÷ 1.24","A1: £30.00 original","M1: 37.20 – 30.00","A1: £7.20 — must state Sienna is WRONG with her figure"],insight:"Half the marks are the calculation, half the explicit verdict. Giving £30 without addressing Sienna earns 2/4 max."}
      ],
      mistakes:["Reverse %: subtracting 20% of £84 (£84 IS 120%, not 100%)","Compound: using simple interest (% × years) instead of power","Not rounding to nearest penny when asked","Evaluate questions: giving a number without stating right/wrong"]
    },
    {id:"1.4",title:"Powers, Roots & Standard Form",
      boards:{AQA:"Index laws, fractional/negative indices. Standard form convert/multiply/divide. Surds simplify/rationalise.",Edexcel:"Evaluate 27^(2/3) — must show root then power. Non-calc standard form. Expand (a+√b)(a-√b).",OCR:"Prove using index laws. Context standard form. 'Show that' with surds."},
      analogy:{icon:"⚡",title:"Index Laws + Standard Form Toolkit",lines:["× same base: aᵐ × aⁿ = aᵐ⁺ⁿ  (ADD)","÷ same base: aᵐ ÷ aⁿ = aᵐ⁻ⁿ  (SUBTRACT)","Power of power: (aᵐ)ⁿ = aᵐⁿ   (MULTIPLY)","Negative index: a⁻ⁿ = 1/aⁿ    (FLIP)","Fraction index: a^(m/n) = (ⁿ√a)ᵐ  (ROOT first, THEN power)","Standard form A × 10ⁿ: if A ≥ 10, MUST adjust!"]},
      markScheme:["Fractional index: M1 correct root, A1 correct power","Standard form: A mark ONLY if 1 ≤ A < 10","Surds 'show that': every expansion visible — no shortcuts","(√5)² = 5 (not √25 or √10) — tested directly"],
      questions:[
        {q:"Evaluate 64^(2/3).",marks:2,diff:"Starter",ms:["M1: ³√64 = 4  (root first)","A1: 4² = 16"],insight:"Denominator = root, numerator = power. ROOT FIRST — 64² first is miserable arithmetic."},
        {q:"Without a calculator, work out  (4 × 10⁵) ÷ (8 × 10²).  Give answer in standard form.",marks:2,diff:"Mid",ms:["M1: 0.5 and 10³","A1: 5 × 10² (must adjust — 0.5 is not ≥ 1)"],insight:"0.5 is NOT between 1 and 10. Multiply by 10, reduce power by 1. Adjustment step = where A marks are lost."},
        {q:"Show that (3 + √5)² – (3 – √5)² = 12√5.",marks:4,diff:"Killer",ms:["M1: (3+√5)² = 14 + 6√5","M1: (3–√5)² = 14 – 6√5","M1: Subtract → 12√5","A1: All steps clearly visible"],insight:"Answer is given. Examiners mark your ALGEBRA. Jumping to 12√5 without expansions = 0/4."}
      ],
      mistakes:["64^(2/3): squaring before rooting","Standard form: 12 × 10⁴ instead of 1.2 × 10⁵","(√5)² = 5 NOT √10","In (3–√5)²: –3√5 × –1 = +3√5 (sign errors)"]
    },
    {id:"1.5",title:"Surds",
      boards:{AQA:"Simplify surds (√48=4√3). Expand double brackets with surds. Rationalise denominator. 'Leave in exact form' = surd answer required.",Edexcel:"(a+√b)² expansion with full working. Rationalise with conjugate. Edexcel Higher: 'Show that...' surd proofs.",OCR:"'Prove that (1+√2)²=3+2√2'. Rationalise complex denominators. 'Express in simplest surd form'."},
      analogy:{icon:"√",title:"Surds — 3 Laws That Cover Everything",lines:["√(ab) = √a × √b  ← use to simplify","SIMPLIFY: find largest perfect square factor","  √48 = √(16×3) = 4√3","EXPAND: FOIL works — (√5)²=5, not √25","RATIONALISE: multiply top and bottom by the surd","  3/√5 → ×(√5/√5) → 3√5/5","CONJUGATE: (a+√b)(a–√b)=a²–b (no surds remain)"]},
      markScheme:["B1 for simplified surd with correct integer coefficient","Expansion: M1 any 3 correct terms, A1 fully simplified","Rationalise: M1 multiply by conjugate, A1 integer denominator","'Exact form': decimal answer scores 0","(√n)²=n, not √(n²)"],
      questions:[
        {q:"Simplify √75.",marks:2,diff:"Starter",ms:["M1: √(25×3)","A1: 5√3"],insight:"Look for the largest square factor of 75. 75=25×3. √25=5. So √75=5√3. Writing √(5×15) then √5×√15 earns M1 but leads nowhere useful — always find the LARGEST square factor first."},
        {q:"Expand and simplify  (3+√5)(3–√5).",marks:2,diff:"Mid",ms:["M1: FOIL: 9–3√5+3√5–(√5)²","A1: 9–5=4"],insight:"Difference of two squares: (a+b)(a–b)=a²–b². Here a=3, b=√5, result is 9–5=4. The middle terms cancel. Result is an integer — this is the conjugate pairing used in rationalising."},
        {q:"Rationalise the denominator of  (5+√3)/(2–√3). Give your answer in the form  a+b√3.",marks:4,diff:"Killer",ms:["M1: Multiply by (2+√3)/(2+√3)","M1: Denominator: (2–√3)(2+√3)=4–3=1","M1: Numerator: (5+√3)(2+√3)=10+5√3+2√3+3=13+7√3","A1: 13+7√3"],insight:"Conjugate of (2–√3) is (2+√3). Denominator becomes 4–3=1 — the surd vanishes. Numerator uses FOIL: 10+5√3+2√3+(√3)²=10+7√3+3=13+7√3."}
      ],
      mistakes:["√48=√4×√12=2√12 — not fully simplified (must reach 4√3)","(2+√3)²=4+3=7 — missing middle term 2×2×√3=4√3","Rationalise: multiplying only the numerator by the conjugate","(√5)²=√25 — correct result is 5 but wrong route confuses students"]
    },
    {id:"1.6",title:"Prime Factorisation, HCF & LCM",
      boards:{AQA:"'Express 360 as product of prime factors in index form'. HCF and LCM from Venn diagram of primes. Prime factorisation to find square roots.",Edexcel:"'Write 2520 as product of its prime factors'. 'Given LCM and one number, find the other'. Integer problems using HCF.",OCR:"'Show that HCF of 126 and 84 is 42'. Applied LCM: 'Two lights flash every 8s and 12s — when do they next flash together?'"},
      analogy:{icon:"🌳",title:"The Factor Tree — Two Answers from One Diagram",lines:["STEP 1: Factor tree until all branches are prime","STEP 2: Write as product in index form","  360 = 2³ × 3² × 5","HCF: shared primes at LOWEST power","LCM: all primes at HIGHEST power","Example: 360=2³×3²×5  and  84=2²×3×7","HCF: 2²×3=12  (shared: 2 and 3, lowest powers)","LCM: 2³×3²×5×7=2520 (all primes, highest powers)"]},
      markScheme:["M1 complete factor tree with all primes visible","A1 correct index form (must write 2³, not 2×2×2)","HCF: M1 correct method (intersect/minimum), A1 correct value","LCM: M1 correct method (union/maximum), A1 correct value","Applied: M1 identifying HCF or LCM as relevant, A1 answer"],
      questions:[
        {q:"Express 360 as a product of its prime factors. Write your answer in index form.",marks:3,diff:"Starter",ms:["M1: Factor tree reaching 2,2,2,3,3,5","M1: All prime factors identified","A1: 2³×3²×5"],insight:"Index form means writing powers (2³ not 2×2×2). Draw the tree: 360=2×180=2×2×90=2×2×2×45=2×2×2×3×15=2×2×2×3×3×5. Collect: three 2s, two 3s, one 5."},
        {q:"Find the HCF and LCM of 84 and 180.",marks:4,diff:"Mid",ms:["M1: 84=2²×3×7  and 180=2²×3²×5","M1: HCF=shared primes at lowest power: 2²×3","A1: HCF=12","A1: LCM=2²×3²×5×7=1260"],insight:"HCF: shared primes (2 and 3) at their lowest power → 2²×3=12. LCM: every prime at its highest power from either number → 2²×3²×5×7=1260. One set of trees, two answers."},
        {q:"Two lights are switched on at the same time. Light A flashes every 36 seconds, Light B every 48 seconds. After how many seconds will they next flash together?",marks:4,diff:"Killer",ms:["M1: 36=2²×3²  and 48=2⁴×3","M1: LCM takes highest power of each prime","A1: LCM=2⁴×3²=16×9=144","A1: 144 seconds"],insight:"'Next flash together' = LCM. Both events repeat — find smallest common multiple. 36=2²×3², 48=2⁴×3. Max power of 2 is 4, max power of 3 is 2. LCM=2⁴×3²=144 seconds."}
      ],
      mistakes:["HCF: using highest power instead of lowest (that gives LCM)","LCM: finding HCF for 'next time together' problems — must use LCM","Not writing index form: 2×2×2 not 2³ loses the A mark","Factor tree: stopping at 4 or 6 (not prime!) — must divide until all branches are prime"]
    }
  ]},
  {id:2,code:"M2",label:"Algebra",color:"#4FC3A1",icon:"∑",topics:[
    {id:"2.1",title:"Expanding & Factorising",
      boards:{AQA:"Expand and simplify. 'Simplify' = collect like terms for M mark. Algebraic proof: every step.",Edexcel:"'Show that (x+3)²–9 = x(x+6)' — full expansion. a>1 quadratics. DOTS in fraction simplification.",OCR:"'Hence factorise' chain questions. Proof with written conclusion."},
      analogy:{icon:"📐",title:"The Grid — Never Miss a Term",lines:["Draw 2×2 grid. First bracket across top, second down side.","(2x + 3)(x – 5):","      2x     +3","  x  | 2x²  | 3x  |"," –5  | –10x | –15 |","Add all 4: 2x² + 3x – 10x – 15 = 2x² – 7x – 15","DOTS shortcut: a² – b² = (a+b)(a–b)"]},
      markScheme:["M1: any 3 correct terms from double bracket expansion","Factorising: M1 for correct x terms in brackets","a>1: M1 for factor pairs giving ac","Proof: every step visible + conclusion in words"],
      questions:[
        {q:"Expand and simplify  (3x – 2)(2x + 5).",marks:2,diff:"Starter",ms:["M1: Any 3 correct terms: 6x², 15x, –4x, –10","A1: 6x² + 11x – 10"],insight:"Grid method: middle terms are 15x and –4x. M mark saved even with one error if 3 terms are right."},
        {q:"a) Factorise  x² – 3x – 18    b) Hence solve  x² – 3x – 18 = 0",marks:4,diff:"Mid",ms:["M1: factors of –18 summing to –3: (–6)(+3)","A1: (x–6)(x+3)","M1: each bracket = 0","A1: x=6 or x=–3"],insight:"'Hence' means use part a. Show the link: 'From (a): (x–6)(x+3)=0'. Writing x=6 from nowhere = 0 method marks."},
        {q:"Prove that (n+3)² – (n–3)² is always a multiple of 12.",marks:5,diff:"Killer",ms:["M1: (n+3)² = n²+6n+9","M1: (n–3)² = n²–6n+9","M1: Subtract → 12n","A1: 12n divisible by 12","A1: Written conclusion"],insight:"5 marks: 2 expansions + subtraction + simplification + conclusion. Missing 'Therefore...' loses final A mark."}
      ],
      mistakes:["(x+3)² = x²+9 (forgetting middle term 6x)","Sign errors in factorising — always check by expanding back","DOTS: forgetting to square root coefficient (9x²–16 → (3x±4) not (9x±4))","Proof: 'it's a multiple of 12' without showing =12n = zero marks"]
    },
    {id:"2.2",title:"Solving Equations",
      boards:{AQA:"Multi-step linear with fractions. Own method for quadratics. Formula on sheet.",Edexcel:"'Solve by completing the square' = method specified. Non-linear simultaneous (4–5 marks). Formula not always given.",OCR:"'To 2 d.p.' signals formula. 'Verify' by substituting back."},
      analogy:{icon:"⚖️",title:"Balance Scale + Quadratic Decision Tree",lines:["Every equation = balance scale. Same operation BOTH sides.","Fractions? Multiply EVERYTHING by the LCM.","DECISION TREE:","Can factorise? → YES: fastest","Says 'exact'/'surd'? → Complete the square","Says '2 d.p.'/'3 s.f.'? → Quadratic formula","Says 'complete the square'? → No choice","Formula: x = (–b ± √(b²–4ac)) / 2a"]},
      markScheme:["Linear: M1 correct first step, A1 solution","Formula: M1 substituting, M1 simplifying discriminant, A1 each solution","CTS: M1 for (x+b/2a)² form, A1 constant, A1 each solution","Simultaneous: M1 equating, M1 first variable, A1 each"],
      questions:[
        {q:"Solve  (3x + 4)/5 – (x – 2)/3 = 2",marks:3,diff:"Starter",ms:["M1: ×15: 3(3x+4) – 5(x–2) = 30","M1: 9x+12–5x+10=30 → 4x=8","A1: x=2"],insight:"LCM of 5 and 3 is 15. Multiply EVERY term including the 2. Show '×15' on both sides — that's the M mark."},
        {q:"Solve  3x² – 5x – 2 = 0  by factorising.",marks:3,diff:"Mid",ms:["M1: ac=–6, factors (–6)(+1) sum to –5","M1: 3x²–6x+x–2 → (3x+1)(x–2)","A1: x=2 or x=–⅓"],insight:"AC method: multiply a×c, find factor pair summing to b, split middle term, group. Show the check for full confidence."},
        {q:"Solve simultaneously:  y = x²–3x+1  and  y = 2x–3. Give exact answers.",marks:5,diff:"Killer",ms:["M1: x²–3x+1 = 2x–3","M1: x²–5x+4=0 → (x–1)(x–4)","M1: x=1 or x=4","A1: (1, –1)","A1: (4, 5)"],insight:"Substitute x values into the LINEAR equation for y. State as coordinates. Finding x without y loses both A marks."}
      ],
      mistakes:["Fractions: multiplying fraction terms only, not the integers","–b in formula: if b=–5, then –(–5)=+5. Sign errors are epidemic.","Non-linear simultaneous: not rearranging to =0 before factorising","Single quadratic solution when two exist"]
    },
    {id:"2.3",title:"Sequences",
      boards:{AQA:"Find nth term linear/quadratic. 'Is 200 in sequence?' — solve for n. Show differences for M mark.",Edexcel:"Given nth term, find which term has a given value. Geometric: prove common ratio by division.",OCR:"Pattern from diagram. 'Show that 5th term is 35'. Geometric with surd ratio."},
      analogy:{icon:"🪜",title:"The Staircase Method",lines:["LINEAR: 1st differences constant = coefficient of n","  3,7,11,15 → diff=4 → 4n+c → c=–1 → 4n–1","QUADRATIC: 2nd differences constant = 2a","  1st diff: 4,6,8 → 2nd diff: 2,2 → a=1","  Form n²+bn+c, use n=1 and n=2 to find b,c","GEOMETRIC: divide consecutive terms to find r"]},
      markScheme:["Linear: M1 common difference, A1 correct nth term with constant","Quadratic: M1 second differences, M1 subtracting n² part, A1 final","'Is X a term?': M1 setting =X and solving, A1 conclusion","Geometric: dividing equations earns M marks independently"],
      questions:[
        {q:"nth term of sequence = 3n²–2n+1.  a) Find 4th term.  b) Is 481 a term? Show working.",marks:4,diff:"Starter",ms:["A1 (a): 41","M1 (b): 3n²–2n–480=0","M1: n=(2±76)/6","A1: n=13 integer ✓ YES"],insight:"'Is X a term?' always means: set nth term = X, solve for n, check if positive integer."},
        {q:"Find the nth term of:  3, 9, 19, 33, 51.",marks:4,diff:"Mid",ms:["M1: 1st diff 6,10,14,18","M1: 2nd diff 4,4 → a=2","M1: Subtract 2n²: 1,1,1,1 → +1","A1: 2n²+1"],insight:"2nd difference ÷ 2 = coefficient of n². Subtract quadratic part — what remains should be constant or linear."},
        {q:"Geometric sequence: 3rd term=20, 6th term=160. Find a and r.",marks:5,diff:"Killer",ms:["M1: ar²=20 and ar⁵=160","M1: Divide: r³=8","A1: r=2","M1: a(4)=20","A1: a=5"],insight:"Dividing equations eliminates a cleanly. Students who substitute instead of divide make far more errors."}
      ],
      mistakes:["Linear nth term: writing 4n instead of 4n–1","Quadratic: using 2nd difference directly (must halve it)","'Is X in sequence?': listing terms instead of solving","Geometric: confusing ratio (divide) with difference (subtract)"]
    },
    {id:"2.4",title:"Graphs & Functions",
      boards:{AQA:"Identify graph type from equation. Sketch quadratic with roots + y-intercept labelled. Gradient of tangent by drawing. Velocity-time: area under graph = displacement.",Edexcel:"Sketch y=x³–3x labelling all intersections. Distance-time: average speed = total distance ÷ total time. 'Estimate area under curve' using trapezium rule.",OCR:"Graph transformations f(x+a), f(x)+a, –f(x), af(x). 'Describe fully'. Match equation to graph type from a list."},
      analogy:{icon:"📈",title:"The Graph Gallery — 6 Shapes to Memorise",lines:["LINEAR y=mx+c: straight line, m=gradient, c=y-intercept","QUADRATIC y=ax²+bx+c: U-shape (a>0) or n-shape (a<0)","CUBIC y=ax³+...: S-shape crossing x-axis up to 3 times","RECIPROCAL y=k/x: two curves in opposite quadrants, NEVER touches axes","EXPONENTIAL y=aˣ: always passes through (0,1), always above x-axis","DISTANCE-TIME: gradient = speed   VELOCITY-TIME: gradient = acceleration, area = displacement"]},
      markScheme:["Sketch: B marks for correct shape + intercepts labelled — shape without labels gets B0","Gradient of tangent: M1 tangent drawn at correct point, M1 rise/run, A1 value","Velocity-time area: M1 splitting into triangles/rectangles, A1 each area, A1 total","Graph transformations: B1 shape correct, B1 translation direction/scale correct","Reciprocal/exponential: must show asymptotic behaviour or mark (0,1)"],
      questions:[
        {q:"Sketch the graph of y = x² – 5x + 4, labelling the x-intercepts and the y-intercept.",marks:3,diff:"Starter",ms:["B1: correct U-shape parabola","B1: x-intercepts at (1,0) and (4,0)","B1: y-intercept at (0,4)"],insight:"Factorise first: (x–1)(x–4)=0 → roots at x=1, x=4. y-intercept: substitute x=0. Sketch shape first, then add labels — without labels, shape marks are at risk."},
        {q:"A velocity-time graph shows a car accelerating from 0 to 20 m/s in 8 seconds, then travelling at constant 20 m/s for 12 seconds, then decelerating to rest in 5 seconds. Calculate the total distance travelled.",marks:4,diff:"Mid",ms:["M1: Triangle 1: ½×8×20=80m","M1: Rectangle: 12×20=240m","M1: Triangle 2: ½×5×20=50m","A1: Total=370m"],insight:"Every region under a velocity-time graph is a distance. Triangle for acceleration/deceleration, rectangle for constant speed. Add ALL areas — never multiply only the final velocity by total time."},
        {q:"The graph of y = x² passes through the point (3, 9). By drawing the tangent at x=3, estimate the gradient of the curve at that point.",marks:3,diff:"Killer",ms:["M1: tangent drawn at x=3 — a straight line just touching the curve","M1: two points on the tangent chosen, rise/run calculated","A1: gradient ≈ 6 (accept 5 to 7)"],insight:"Choose points on the TANGENT line, not on the curve. The tangent at x=3 on y=x² has exact gradient 6. Draw it carefully and read off two clear coordinates from the straight line."}
      ],
      mistakes:["Reciprocal graph: drawing a V-shape instead of two separate curves in opposite quadrants","Distance-time gradient: dividing time by distance instead of distance ÷ time","Velocity-time: reading off final velocity as the total distance","Graph transformation y=f(x+2): shifts LEFT not right (opposite to intuition)"]
    },
    {id:"2.5",title:"Inequalities",
      boards:{AQA:"Linear: solve and mark on number line (open/closed circles). Quadratic: sketch and identify region. 'List integer values of n'. Integer solutions must all be listed.",Edexcel:"Graphical regions: shade unwanted region. 'Label the region R'. 'Write down the three inequalities that define region R'.",OCR:"'Write the inequality shown on the number line'. Combined inequalities as a single expression. Integer solutions with working shown."},
      analogy:{icon:"⚖️",title:"Three Inequality Types — One Key Rule",lines:["GOLDEN RULE: flip the inequality sign when multiplying/dividing by a NEGATIVE number","LINEAR: 3x>–9 → x>–3 (÷3, positive: no flip)","–2x>6 → x<–3 (÷–2: FLIP)","NUMBER LINE: open circle=strict < or >   closed circle=≤ or ≥","QUADRATIC: factorise → find roots → sketch parabola","  x²–5x+4<0 → roots 1 and 4 → answer: 1<x<4 (below x-axis = between roots)","GRAPHICAL: solid line for ≤ or ≥   dashed line for < or >"]},
      markScheme:["Linear: M1 correct method, A1 correct inequality (with correct direction)","Number line: B1 open/closed circle, B1 correct arrow direction","Quadratic: M1 roots found, M1 correct region (above or below), A1 inequality","Graphical: B1 each line drawn correctly, B1 correct region shaded/identified","Integer list: every integer required — missing one loses A mark"],
      questions:[
        {q:"Solve  4x – 3 > 2x + 9  and show your answer on a number line.",marks:3,diff:"Starter",ms:["M1: 2x>12","A1: x>6","B1: open circle at 6, arrow pointing right"],insight:"Open circle because > (strict inequality). A closed circle would mean x≥6 which is wrong. The number line B mark is independent of the algebra — draw it even if unsure of the answer."},
        {q:"Solve  x² – 2x – 15 < 0  and write the solution as a single inequality.",marks:4,diff:"Mid",ms:["M1: (x–5)(x+3)=0, roots x=5 and x=–3","M1: sketch U-shape parabola, below x-axis between the roots","A1: –3 < x < 5"],insight:"'<0' means BELOW the x-axis. The U-shaped parabola is below the axis between its roots. Answer must be a combined inequality — writing x>–3 and x<5 separately loses the final A mark."},
        {q:"On a coordinate grid, shade the region R that satisfies all three inequalities: y ≥ x+1,  y < 4,  x+y ≤ 6.",marks:5,diff:"Killer",ms:["B1: y=x+1 drawn as solid line, region above it","B1: y=4 drawn as dashed line, region below it","B1: x+y=6 drawn as solid line, region below it","M1: three regions overlapped","A1: correct bounded region R clearly labelled"],insight:"Solid line for ≥ and ≤, dashed line for < and >. Shade the unwanted regions or clearly label the required region R. The bounded triangle where all three conditions hold simultaneously is the answer."}
      ],
      mistakes:["Dividing/multiplying by negative without flipping the inequality sign","Number line: closed circle for strict inequality (or open for ≤)","Quadratic: x²>9 → only writing x>3, forgetting x<–3","Graphical: shading the required region instead of the unwanted regions (varies by board — check instructions)"]
    },
    {id:"2.6",title:"Iteration",
      boards:{AQA:"'Show the equation has a root between x=1 and x=2 using change of sign'. Rearrange to iterative form. Show every xₙ value.",Edexcel:"Rearrange equation to xₙ₊₁=g(xₙ) form. 'Find root to 3 d.p.' — show two consecutive values agreeing. Staircase diagram on Higher.",OCR:"'Starting from x₀=2, find x₁, x₂, x₃'. Explain why iteration converges. 'Verify root to 2 d.p. using change of sign'."},
      analogy:{icon:"🌀",title:"Iteration — Zooming Into the Root",lines:["Think of a camera zooming in on the exact root step by step.","START: substitute x₀ into formula xₙ₊₁ = g(xₙ)","x₁ = g(x₀), then x₂ = g(x₁), then x₃ = g(x₂)...","CONVERGED when consecutive values round to the same d.p.","CHANGE OF SIGN: f(a) negative, f(b) positive → root is between a and b","VERIFY: f(2.345) and f(2.355) — opposite signs confirms root = 2.35 to 2 d.p."]},
      markScheme:["M1 for correct first iteration x₁ (must show substitution)","A marks for correct subsequent values","Change of sign: M1 both f(a) and f(b) calculated, A1 sign change + conclusion in words","Root to n d.p.: show two consecutive iterations agreeing to that accuracy","Rearrangement: M1 algebraic steps visible — cannot jump to formula"],
      questions:[
        {q:"Show that  x³ + 2x – 5 = 0  has a root between x=1 and x=2.",marks:2,diff:"Starter",ms:["M1: f(1)=1+2–5=–2 and f(2)=8+4–5=7","A1: sign change from –2 to +7 → root between x=1 and x=2"],insight:"Substitute BOTH values and state the sign change explicitly: 'f(1)=–2 (negative) and f(2)=7 (positive), therefore there is a change of sign so a root lies between x=1 and x=2'."},
        {q:"The equation x³+2x–5=0 can be rearranged to  xₙ₊₁ = ∛(5–2xₙ).  Starting with x₀=1, find the root to 2 decimal places.",marks:4,diff:"Mid",ms:["M1: x₁=∛(5–2)=∛3=1.4422...","M1: x₂=∛(5–2.8845)=1.2765...","M1: iterations continue, values converging","A1: root≈1.33 (two consecutive values agree to 2 d.p.)"],insight:"Show EVERY intermediate value — x₁=..., x₂=..., x₃=... Each line is a method mark opportunity. Writing only the final answer loses all the M marks."},
        {q:"Show that  x³–3x+1=0  can be rearranged to  xₙ₊₁=∛(3xₙ–1). Starting at x₀=2, find x₃ to 4 decimal places.",marks:5,diff:"Killer",ms:["M1: x³=3x–1 so x=∛(3x–1) — show rearrangement","M1: x₁=∛(3×2–1)=∛5=1.7100","M1: x₂=∛(3×1.7100–1)=∛4.13=1.6035","M1: x₃=∛(3×1.6035–1)=∛3.811=1.5604","A1: 1.5604"],insight:"The rearrangement is a separate mark — show x³=3x–1 explicitly. Then write every iteration on its own line. 'x₃=1.5604' alone without the working earns 1 mark at best."}
      ],
      mistakes:["Showing only the final answer without each intermediate xₙ step","Change of sign: only evaluating f at one endpoint","Confusing the iterative formula with the original equation","Root to 2 d.p.: not checking that two consecutive iterations agree at that precision"]
    },
    {id:"2.7",title:"Algebraic Proof",
      boards:{AQA:"'Prove that (2n+1)²–1 is always a multiple of 4'. Conclusion required in words. Counter-example questions for disproof.",Edexcel:"'Show that the sum of three consecutive integers is always a multiple of 3'. Must use algebra throughout — no substitution.",OCR:"'Prove or disprove'. Counter-example acceptable for disproving. Written conclusion must include the property being proved."},
      analogy:{icon:"🔐",title:"The Proof Framework — 5 Steps Every Time",lines:["STEP 1: Define variables — even=2n, odd=2n+1, consecutive=n,n+1,n+2","STEP 2: Write the expression algebraically using definitions","STEP 3: Expand and simplify fully — show every step","STEP 4: Factorise to reveal the required structure","STEP 5: Write conclusion in WORDS — 'therefore always a multiple of 4'","DISPROVING: one counter-example is sufficient — state it clearly","Different odd numbers: use 2m+1 and 2n+1 (different letters!)"]},
      markScheme:["M1 correct algebraic expressions for even/odd/consecutive numbers","M1 correct expansion and simplification","A1 factorised form revealing multiple/even/odd structure","B1 written conclusion required — symbolic result without words loses this mark","Counter-example: B2 valid example + clear explanation — no algebra needed"],
      questions:[
        {q:"Prove that the product of two odd numbers is always odd.",marks:3,diff:"Starter",ms:["M1: Let the odd numbers be (2m+1) and (2n+1)","M1: Product=(2m+1)(2n+1)=4mn+2m+2n+1","A1: =2(2mn+m+n)+1 which is of the form 2k+1, so always odd"],insight:"Use different letters for two different odd numbers — both 2n+1 only gives the product of a number with itself. The final step must show the form 2k+1 and state 'always odd'."},
        {q:"Prove that (n+3)²+(n–1)² is always even for any integer n.",marks:4,diff:"Mid",ms:["M1: (n+3)²=n²+6n+9","M1: (n–1)²=n²–2n+1","M1: Sum=2n²+4n+10","A1: =2(n²+2n+5) which is a multiple of 2, therefore always even"],insight:"Even means divisible by 2 — factorise out 2. The bracket n²+2n+5 is an integer whenever n is an integer, confirming the product is always even. Write the conclusion."},
        {q:"Prove algebraically that the sum of the squares of two consecutive even numbers is never a multiple of 8.",marks:5,diff:"Killer",ms:["M1: consecutive even: 2n and 2n+2","M1: (2n)²+(2n+2)²=4n²+4n²+8n+4","M1: =8n²+8n+4","M1: =8(n²+n)+4","A1: remainder 4 when divided by 8, therefore never a multiple of 8"],insight:"=8(n²+n)+4 shows that dividing by 8 always leaves remainder 4. The conclusion 'therefore never a multiple of 8' is the final A mark. Without those words, the algebra alone is worth 4/5."}
      ],
      mistakes:["Using specific numbers (n=3) — this is verification, not proof","Missing written conclusion — symbolic result without words loses B marks","Two odd numbers: using 2n+1 for both (must use 2m+1 and 2n+1)","Not fully factorising — 4n²+8n+4 must become 4(n²+2n+1) to show divisibility"]
    },
    {id:"2.8",title:"Straight Line Graphs",
      boards:{AQA:"Find equation from two points. Parallel lines: equal gradients. 'Is point P on line L?' — substitute and check. Rearrange ax+by=c to y=mx+c form.",Edexcel:"'Find equation of perpendicular bisector of AB'. Midpoint + perpendicular gradient. 'Show that lines are perpendicular'.",OCR:"'Line L: 4x–2y=7. Find equation through (3,1) parallel to L'. Rearrange first. Distance between two points from Pythagoras."},
      analogy:{icon:"📏",title:"3 Line Situations — One Formula",lines:["GRADIENT: m=(y₂–y₁)/(x₂–x₁) = rise/run","EQUATION: y–y₁=m(x–x₁) then rearrange","PARALLEL: same gradient (m₁=m₂)","PERPENDICULAR: m₁×m₂=–1 (negative reciprocal)","  perpendicular to m=3 → m=–⅓","REARRANGING ax+by=c: get y on left","  4x–2y=7 → 2y=4x–7 → y=2x–3.5 → m=2","y-intercept: substitute x=0. x-intercept: y=0."]},
      markScheme:["M1 gradient calculated correctly with correct formula","A1 equation in y=mx+c or equivalent","Perpendicular: M1 negative reciprocal gradient identified","Midpoint: M1 correct formula ((x₁+x₂)/2,(y₁+y₂)/2)","'Show that': verify by substituting coordinates with working"],
      questions:[
        {q:"Find the equation of the line passing through (2,3) and (6,11). Give your answer in the form y=mx+c.",marks:3,diff:"Starter",ms:["M1: m=(11–3)/(6–2)=8/4=2","M1: y–3=2(x–2)→y=2x–1","A1: y=2x–1"],insight:"Gradient first: rise/run=(11–3)/(6–2)=2. Then substitute one point into y–y₁=m(x–x₁). Rearrange. Check: y=2(6)–1=11 ✓ — verifying with the second point confirms the answer."},
        {q:"Line L has equation y=3x–4. Line M is perpendicular to L and passes through (6,1). Find the equation of M.",marks:3,diff:"Mid",ms:["M1: gradient of L=3 → gradient of M=–⅓","M1: y–1=–⅓(x–6)","A1: y=–⅓x+3  or  x+3y=9"],insight:"Perpendicular gradient = negative reciprocal: –1/3. Into y–y₁=m(x–x₁): y–1=–⅓(x–6) → y=–⅓x+2+1=–⅓x+3. Check: at x=6, y=–2+3=1 ✓"},
        {q:"A is (1,5) and B is (7,–1). a) Find the midpoint M of AB. b) Find the equation of the perpendicular bisector of AB.",marks:5,diff:"Killer",ms:["A1: M=(4,2)","M1: gradient AB=(–1–5)/(7–1)=–1","M1: perp bisector gradient=1","M1: y–2=1(x–4)","A1: y=x–2"],insight:"Perpendicular bisector: passes through midpoint, perpendicular to AB. Midpoint=((1+7)/2,(5+–1)/2)=(4,2). Gradient AB=–6/6=–1. Perp gradient=1. y–2=x–4 → y=x–2."}
      ],
      mistakes:["Gradient: (y₁–y₂)÷(x₂–x₁) — wrong order gives negative of correct answer","Perpendicular: only negating (need to also flip the fraction)","Parallel: using same y-intercept instead of same gradient","Equation from graph: y-intercept read incorrectly when scale isn't 1:1"]
    },
    {id:"2.9",title:"Functions (IGCSE Higher)",
      boards:{'Edexcel IGCSE':"Paper 2H only. f(x) notation, domain/range, composite fg(x), inverse f⁻¹(x). 'Find fg(3)' and 'Find f⁻¹(x)' are standard question types. NOT on standard GCSE — IGCSE Higher only."},
      analogy:{icon:"🔧",title:"Functions — Input → Machine → Output",lines:["f(x) = the machine. x = the input. f(x) = the output.","COMPOSITE fg(x): apply g FIRST, then f","  fg(3): step 1 find g(3), step 2 find f(that answer)","  fg(x): replace x in f with the expression for g(x)","INVERSE f⁻¹(x): reverse the machine","  Write y=f(x), swap x and y, rearrange for y","  That rearranged y IS f⁻¹(x)","CHECK: ff⁻¹(x)=x always — use to verify your answer"]},
      markScheme:["Composite: M1 correct order (g first, then f), A1 correct value or expression","Inverse: M1 swap x and y, M1 rearrange correctly, A1 simplified expression","'Find fg(x)': substitute g(x) into f — show the substitution step","Domain/range: B1 each — domain is inputs, range is outputs","ff⁻¹(x)=x: verify by substituting — earns a check mark"],
      questions:[
        {q:"f(x) = 3x + 1  and  g(x) = x² – 4.  Find:  a) fg(2)   b) gf(x)",marks:5,diff:"Starter",ms:["M1: g(2)=4–4=0","A1: fg(2)=f(0)=1","M1: f(x)=3x+1 substituted into g","M1: gf(x)=(3x+1)²–4","A1: 9x²+6x–3"],insight:"Composite fg means g first, then f. fg(2): find g(2)=0, then f(0)=1. For gf(x): put the whole of f(x) into g(x), expand the bracket carefully — (3x+1)²=9x²+6x+1, then –4 gives 9x²+6x–3."},
        {q:"f(x) = (2x + 5)/3.  Find f⁻¹(x).",marks:3,diff:"Mid",ms:["M1: y=(2x+5)/3","M1: swap: x=(2y+5)/3 → 3x=2y+5 → 2y=3x–5","A1: f⁻¹(x)=(3x–5)/2"],insight:"Inverse: write y=f(x), swap x and y everywhere, rearrange for y. Check: f(f⁻¹(4))=f((12–5)/2)=f(3.5)=(7+5)/3=4 ✓. The check always works if your inverse is correct."},
        {q:"f(x) = 2x – 3  and  g(x) = x² + 1.  a) Solve fg(x) = 25.   b) Find gf⁻¹(x).",marks:6,diff:"Killer",ms:["M1: fg(x)=f(x²+1)=2(x²+1)–3=2x²–1","M1: 2x²–1=25 → x²=13","A1: x=±√13","M1: f⁻¹(x)=(x+3)/2","M1: gf⁻¹(x)=((x+3)/2)²+1","A1: (x²+6x+9)/4+1=(x²+6x+13)/4"],insight:"fg(x): substitute g into f first. Set =25 and solve the quadratic. For gf⁻¹(x): find f⁻¹ first, then substitute into g. Don't forget ±√13 for part a — quadratic solutions come in pairs."}
      ],
      mistakes:["fg(x): applying f first instead of g first — must apply g first","Inverse: rearranging f(x) without swapping x and y first","Composite value: finding f(2) then g(2) and adding, rather than feeding f into g","Forgetting ±√ when solving x²=k in equations"]
    },
    {id:"2.10",title:"Calculus: Differentiation (IGCSE Higher)",
      boards:{'Edexcel IGCSE':"Paper 2H only. Differentiation of polynomials: dy/dx = nxⁿ⁻¹. Gradient of curve at a point. Stationary points (dy/dx=0). Increasing/decreasing functions. Integration as reverse differentiation. NOT on standard GCSE — IGCSE Higher only."},
      analogy:{icon:"📉",title:"Differentiation — Finding the Gradient at Any Point",lines:["RULE: if y = axⁿ, then dy/dx = naxⁿ⁻¹","  Multiply by power, then reduce power by 1","  y = 3x²  →  dy/dx = 6x","  y = 5x³ – 2x + 7  →  dy/dx = 15x² – 2","GRADIENT AT A POINT: substitute x into dy/dx","  y=3x², gradient at x=4: dy/dx=6(4)=24","STATIONARY POINTS: dy/dx = 0, then solve for x","  Then substitute x into y= to get the coordinates","INCREASING: dy/dx > 0. DECREASING: dy/dx < 0","CONSTANT: dy/dx = 0 (not the same as a stationary point of curve)"]},
      markScheme:["M1 correct differentiation of at least one term using power rule","A1 fully correct dy/dx expression","Gradient at point: M1 substitute x into dy/dx, A1 correct value","Stationary point: M1 dy/dx=0, M1 solve for x, A1 coordinates (x and y both needed)","Increasing/decreasing: M1 correct inequality, A1 correct range — must use dy/dx"],
      questions:[
        {q:"Given  y = 3x³ – 5x² + 2.  Find dy/dx.",marks:2,diff:"Starter",ms:["M1: Differentiate term by term","A1: dy/dx = 9x² – 10x"],insight:"Differentiate each term: 3x³ → 3×3x² = 9x². Then 5x² → 5×2x = 10x. Constant 2 → 0 (constants always disappear). dy/dx = 9x² – 10x. Check each term individually."},
        {q:"A curve has equation  y = x³ – 6x² + 9x + 1.\na) Find dy/dx.\nb) Find the coordinates of both stationary points.",marks:6,diff:"Mid",ms:["M1: dy/dx=3x²–12x+9","A1: correct dy/dx","M1: 3x²–12x+9=0 → x²–4x+3=0","M1: (x–1)(x–3)=0 → x=1 and x=3","A1: (1, 5)","A1: (3, 1)"],insight:"Stationary points: set dy/dx=0 and solve. Always find both x AND y coordinates — just giving x values loses the A marks. Substitute back into the original equation y= for the y coordinates."},
        {q:"A curve has equation  y = 2x³ – 3x² – 12x + 4.\na) Show that the curve is decreasing when  –1 < x < 2.\nb) Find the x-coordinates where the curve has zero gradient.",marks:5,diff:"Killer",ms:["M1: dy/dx=6x²–6x–12","M1: 6x²–6x–12<0 → x²–x–2<0","M1: (x–2)(x+1)<0 → –1<x<2 confirmed","M1: 6x²–6x–12=0 → x=2 and x=–1","A1: x=–1 and x=2"],insight:"Decreasing: dy/dx<0. Factorise and find roots, then sketch quadratic to identify where it's negative (between roots for positive leading coefficient). Zero gradient: same roots where dy/dx=0. 'Show that' means show every step including the inequality reasoning."}
      ],
      mistakes:["Not reducing the power: y=3x² → dy/dx=3x² (forgetting to reduce from 2 to 1)","Constants: dy/dx of 7 is 0, not 7 and not 7x","Stationary points: only giving x values without finding y coordinates","Increasing/decreasing: using y= instead of dy/dx — must use the derivative","Sign of leading coefficient: dy/dx<0 between roots only when coefficient of x² is positive"]
    },
    {id:"2.11",title:"Completing the Square",
      boards:{AQA:"'Express in the form (x+p)²+q'. 'Find the minimum value'. Solve by completing the square — exact surd answers. Discriminant to determine number of roots.",Edexcel:"'By completing the square, solve x²+6x–1=0. Give exact answers.' Sketch parabola with turning point and intercepts labelled. 'Show the minimum value is –q'.",OCR:"'State the coordinates of the turning point'. Use completed square to sketch. Discriminant: 'explain how many solutions this equation has, giving a reason'."},
      analogy:{icon:"🎯",title:"Completing the Square — 3 Things in One",lines:["STEP 1: Halve the coefficient of x → p","STEP 2: (x+p)² expands to x²+2px+p² — you added p² extra","STEP 3: Subtract p² to compensate","  x²+8x+5 → (x+4)²–16+5 = (x+4)²–11","TURNING POINT: x=–p, y=q  (minimum if a>0)","SOLVE by CTS: (x+4)²=11 → x+4=±√11 → x=–4±√11","DISCRIMINANT b²–4ac: >0 two roots, =0 one root, <0 no roots"]},
      markScheme:["CTS: M1 for (x+p)² form with correct p (half coefficient), A1 correct constant q","Turning point: B1 x-coordinate = –p (opposite sign to bracket), B1 y-coordinate = q","Solve by CTS: M1 square root both sides with ±, A1 both exact solutions","Discriminant: B1 correct value computed, B1 correct conclusion in words","Sketch: B1 turning point, B1 correct shape, B1 y-intercept"],
      questions:[
        {q:"Express  x² + 10x + 3  in the form  (x + p)² + q.",marks:2,diff:"Starter",ms:["M1: p = 5 (half of 10), (x+5)² = x²+10x+25","A1: (x+5)² – 25 + 3 = (x+5)² – 22"],insight:"Halve the x coefficient to get p=5. (x+5)² adds 25 extra, so subtract 25 and add back the original +3. Always verify: expand (x+5)²–22 = x²+10x+25–22 = x²+10x+3 ✓"},
        {q:"a) Write  x² – 6x + 2  in the form  (x+p)² + q.\nb) Hence write down the coordinates of the minimum point of  y = x² – 6x + 2.\nc) Solve  x² – 6x + 2 = 0,  giving your answers in exact form.",marks:6,diff:"Mid",ms:["M1: (x–3)² – 9 + 2","A1: (x–3)² – 7","B1: minimum at (3, –7)","M1: (x–3)² = 7","M1: x–3 = ±√7","A1: x = 3±√7"],insight:"The completed square form does three jobs: form (for marks), turning point (opposite sign from bracket, same as constant), and solving (rearrange to x=). Exact form means leave ±√7 — do not use a calculator."},
        {q:"Use the discriminant to determine how many real solutions  3x² – 4x + 5 = 0  has. Give a reason.",marks:3,diff:"Killer",ms:["M1: b²–4ac = (–4)²–4(3)(5) = 16–60","A1: –44","B1: –44 < 0 so no real solutions — the graph does not cross the x-axis"],insight:"Identify a=3, b=–4, c=5 carefully. (–4)²=16, not –16. Negative discriminant means no real roots — the parabola sits entirely above (or below) the x-axis. Must state conclusion in words for the final B mark."}
      ],
      mistakes:["Forgetting to subtract p²: writing (x+5)²+3 instead of (x+5)²–22","Turning point x-coordinate: writing +p not –p (wrong sign from bracket)","Solving: taking only positive square root — always need ±","Discriminant: computing –4² as –16 instead of (–4)²=+16","a≠1: must divide through first or use full 'ax+b)² form"]
    }
  ]},
  {id:3,code:"M3",label:"Ratio & Rates",color:"#E07B54",icon:"∶",topics:[
    {id:"3.1",title:"Ratio",
      boards:{AQA:"'Share £360 in ratio 3:5:4' — show total parts and unit value for M marks.",Edexcel:"Multi-step embedded: alloys, mixtures. Combine ratios via linking term.",OCR:"'Express in form 1:n'. Probability + ratio combined questions."},
      analogy:{icon:"⚖️",title:"The Ratio Toolkit — 3 Scenarios",lines:["SCENARIO 1 — Share total in ratio 3:5:","  Add parts=8. Divide £240÷8=£30. Multiply: 3×£30, 5×£30","SCENARIO 2 — One share given:","  A:B=3:5, A=£90. One part=£90÷3=£30. B=5×£30=£150","SCENARIO 3 — Combine A:B=2:3, B:C=4:5:","  Equalise B: A:B=8:12, B:C=12:15 → 8:12:15"]},
      markScheme:["M1 total parts, M1 unit value, A1 correct share","Show: total parts → unit value → individual shares","Simplify probability for final A mark","Combining: must show equalisation step explicitly"],
      questions:[
        {q:"Share £780 in the ratio 3:7:2. How much is the largest share?",marks:3,diff:"Starter",ms:["M1: 12 parts","M1: £65 per part","A1: £455"],insight:"Show ALL three steps. £455 alone earns 1/3 at best."},
        {q:"Counters in ratio red:blue:green = 4:3:5. There are 24 red.\na) Total?  b) P(blue)?",marks:4,diff:"Mid",ms:["M1: 1 part=6","A1: total=72","M1: blue=18","A1: 1/4"],insight:"Unit value first, derive everything else. Must simplify 18/72 to 1/4."},
        {q:"Angles of a quadrilateral are in ratio 2:3:4:6. Show one is obtuse and determine if any are reflex.",marks:4,diff:"Killer",ms:["M1: 15 parts","M1: 24° per part","A1: 48°,72°,96°,144°","A1: 96° obtuse, none reflex"],insight:"Quadrilateral = 360°. Must STATE which is obtuse and confirm no reflex with reason."}
      ],
      mistakes:["Unit value error: multiplying ratio numbers not unit value","Not simplifying probability","Combining ratios: ignoring that B's value differs","'Show that': finding angles without explaining the property"]
    },
    {id:"3.2",title:"Direct & Inverse Proportion",
      boards:{AQA:"'y directly proportional to x²...' — stepwise working required.",Edexcel:"Applied: springs, pressure. 'Express as equation'. Inverse: P×V = constant.",OCR:"'Show that y inversely proportional to x' — verify xy = const. Describe from graph."},
      analogy:{icon:"🔗",title:"The Proportion Framework — Same 5 Steps Always",lines:["Direct: y=kx  Direct²: y=kx²  Inverse: y=k/x","SAME 5 STEPS FOR ALL:","1. Write equation with k","2. Substitute given pair","3. Solve for k","4. Write complete equation","5. Substitute new value, find answer"]},
      markScheme:["M1 correct equation with k","M1 substituting to find k","A1 complete equation","A1 final value","Applied: positive values only — state this"],
      questions:[
        {q:"y ∝ x³. When x=2, y=24. Find y when x=3.",marks:3,diff:"Starter",ms:["M1: y=kx³, 24=8k, k=3","A1: y=3x³","A1: 81"],insight:"Always write equation WITH k first. 3 marks = finding k + equation + value."},
        {q:"P inversely proportional to Q². P=50 when Q=2. Find Q when P=2.",marks:4,diff:"Mid",ms:["M1: P=k/Q²","M1: k=200","A1: P=200/Q²","A1: Q=10 (positive only)"],insight:"State 'Q=10 only' — physical quantity must be positive. This secures the A mark."},
        {q:"Pendulum time T ∝ √L. L=25cm gives T=2s. Find L when T=3s.",marks:4,diff:"Killer",ms:["M1: T=k√L, k=0.4","A1: T=0.4√L","M1: √L=7.5","A1: L=56.25 cm"],insight:"Final step: √L=7.5 → L=56.25 (SQUARE both sides). L=√7.5 is a common wrong answer."}
      ],
      mistakes:["Writing y=3x when y∝x²","Not finding k before answering","Confusing y=k/x with y=kx","Negative roots in applied contexts"]
    },
    {id:"3.3",title:"Speed, Distance & Time",
      boards:{AQA:"SDT triangle. Multi-leg journey average speed. Unit conversions km/h↔m/s (÷3.6). Time as decimal hours — not hrs:mins.",Edexcel:"Distance-time graph: gradient=speed, horizontal=stationary. 'Compare speeds of two sections'. Multi-leg: total distance ÷ total time.",OCR:"'Show that average speed is 80 km/h'. Convert units in context. Distance-time to velocity-time interpretation."},
      analogy:{icon:"🚗",title:"The SDT Triangle — Cover What You Want",lines:["      D","  ─────────","  S  ×  T","Speed=D÷T    Distance=S×T    Time=D÷S","UNIT CONVERSIONS:","  km/h to m/s: ÷3.6   (or ×5/18)","  m/s to km/h: ×3.6   (or ×18/5)","TIME: 1h 30min = 1.5 hours (NOT 1.3)","AVERAGE SPEED: total distance ÷ TOTAL time","  Never take the mean of two speeds!"]},
      markScheme:["M1 correct formula, A1 correct answer with units","Unit conversion: M1 method (×3.6 or ÷3.6), A1 correct value","Average speed: M1 total distance, M1 total time, A1 division","Time: M1 convert to consistent unit, A1 with correct unit","Missing units: loses A mark on OCR"],
      questions:[
        {q:"A car travels 135 km at an average speed of 60 km/h. How long does the journey take? Give your answer in hours and minutes.",marks:2,diff:"Starter",ms:["M1: T=D÷S=135÷60=2.25 hours","A1: 2 hours 15 minutes"],insight:"2.25 hours is NOT 2 hours 25 minutes. Decimal → minutes: 0.25×60=15. So 2 hours 15 minutes. Always convert decimal time if the question asks for hours and minutes."},
        {q:"A train travels 120 km at 80 km/h, then 90 km at 60 km/h. Find the average speed for the whole journey.",marks:4,diff:"Mid",ms:["M1: Time₁=120÷80=1.5 hours","M1: Time₂=90÷60=1.5 hours","M1: Average speed=210÷3","A1: 70 km/h"],insight:"Average speed = TOTAL distance ÷ TOTAL time. Not (80+60)/2=70 — that coincidentally matches here only because the times are equal. Always compute total D and total T separately."},
        {q:"Convert 54 km/h to m/s. Show your working.",marks:2,diff:"Killer",ms:["M1: 54÷3.6  or  54×(1000/3600)","A1: 15 m/s"],insight:"km/h to m/s: ÷3.6 or ×5/18. 54÷3.6=15. Alternatively: 54×1000=54000m per hour, ÷3600=15m per second. Show the conversion step explicitly — the M mark is for the method."}
      ],
      mistakes:["2.25 hours = 2h 25min — decimal hours and clock time are different","Average speed: averaging the two speeds rather than total D ÷ total T","T=D×S instead of T=D÷S — wrong formula from misremembering triangle","Failing to state units — loses the A mark"]
    },
    {id:"3.4",title:"Compound Measures",
      boards:{AQA:"Density=mass÷volume, Pressure=force÷area. 'Which container gives greater pressure?' — compare. Mixed units: g/cm³ vs kg/m³.",Edexcel:"Multi-material density. 'Find density of combined object'. Flow rate in litres/min. Population density.",OCR:"'Show object floats by comparing densities'. Convert density units (g/cm³ to kg/m³: ×1000). Applied: dosage in mg/kg."},
      analogy:{icon:"⚖️",title:"Three Compound Measure Triangles",lines:["DENSITY:  M      PRESSURE:  F      SPEED: D","        ─────             ─────          ────","        D × V             P × A          S × T","D=M/V  M=D×V  V=M/D","P=F/A  F=P×A  A=F/P","UNIT CHECK — must be consistent:","  mass(kg) + volume(m³) → density(kg/m³)","  mass(g)  + volume(cm³)→ density(g/cm³)","FLOW RATE: Volume = Rate × Time"]},
      markScheme:["M1 correct formula, M1 substitution, A1 value + units","Units: wrong or missing units loses A mark","Comparison: must show both values and state which is greater","Conversion: 1 g/cm³ = 1000 kg/m³ — M1 if correct conversion shown","Flow rate: M1 rate×time, A1 correct total"],
      questions:[
        {q:"A metal block has mass 450 g and volume 60 cm³. Calculate its density. State your units.",marks:2,diff:"Starter",ms:["M1: D=M÷V=450÷60","A1: 7.5 g/cm³"],insight:"Density = Mass ÷ Volume. Units follow from the inputs: g ÷ cm³ = g/cm³. Always state units — 7.5 alone loses the A mark."},
        {q:"Object A: mass 2.4 kg, volume 300 cm³. Object B: mass 1.8 kg, volume 150 cm³. Which has greater density? Show working.",marks:4,diff:"Mid",ms:["M1: Convert masses: 2400g and 1800g","M1: Density A=2400÷300=8 g/cm³","M1: Density B=1800÷150=12 g/cm³","A1: Object B has greater density (12>8 g/cm³)"],insight:"Show both calculations AND state the comparison with values. 'B has greater density' alone earns 1/4. 'Density A=8, Density B=12' without conclusion earns 2/4. All three elements needed for full marks."},
        {q:"Water flows through a pipe at 0.8 litres per second. A tank holds 1,200 litres. How many minutes will it take to fill the tank?",marks:3,diff:"Killer",ms:["M1: Time=Volume÷Rate=1200÷0.8=1500 seconds","M1: Convert to minutes: 1500÷60","A1: 25 minutes"],insight:"Flow rate: Time=Volume÷Rate. 1200÷0.8=1500 seconds. Then ÷60=25 minutes. Two-step with unit conversion — each step is a method mark. Skipping the conversion and giving 1500 loses the final A mark."}
      ],
      mistakes:["Density: V=M/D but writing D=V/M (inverted)","Pressure: A=F/P but computing F=P/A","Units: kg and cm³ mixed without converting — gives kg/cm³ which is wrong","Comparison: computing only one density then guessing the comparison"]
    }
  ]},
  {id:4,code:"M4",label:"Geometry",color:"#9B59B6",icon:"△",topics:[
    {id:"4.1",title:"Angles & Circle Theorems",
      boards:{AQA:"State theorem name with every angle. Geometric proof. Parallel line rules must be named.",Edexcel:"Multi-theorem questions. 'Find angle BDC giving reasons'.",OCR:"'Give a reason for each angle'. Prove triangle OAB is isosceles."},
      analogy:{icon:"⭕",title:"The 8 Circle Theorems — All Exam Targets",lines:["1. Centre angle = 2× circumference angle (same arc)","2. Angles in same segment equal","3. Angle in semicircle = 90°","4. Opposite angles cyclic quad = 180°","5. Tangent ⊥ radius at contact point","6. Tangents from external point equal","7. Alternate segment theorem","8. Perpendicular from centre bisects chord","RULE: Name the theorem. '58°' alone = 0 marks for that step."]},
      markScheme:["Every angle: value + reason = separate marks","'Reason' = full theorem name","Parallel lines: must state the lines are parallel","Proof: cite specific geometric property, never 'it looks like'"],
      questions:[
        {q:"A,B,C,D on circle. Angle BAD=73°. Find angle BCD with reason.",marks:2,diff:"Starter",ms:["A1: 107°","A1: Opposite angles in cyclic quad add to 180°"],insight:"Reason mark is separate. 107° alone = 1/2. Theorem name must include the 180° property."},
        {q:"O is centre. A,B,C on circumference. Angle AOB=136°. Find angle ACB with full reason.",marks:3,diff:"Mid",ms:["M1: 136÷2=68°","A1: 68°","A1: Angle at centre = 2× angle at circumference on same arc AB"],insight:"'Same arc AB' is required. OCR and AQA both require this detail for the reason mark."},
        {q:"PT tangent at T, O centre. Angle PTB=58°. Find angle TOB — full reasoning for each step.",marks:5,diff:"Killer",ms:["M1+A1: angle OTP=90° (tangent⊥radius)","M1+A1: angle OTB=32°","A1: OT=OB radii → isosceles → TOB=116°"],insight:"Map the chain: tangent→90°→subtract→isosceles→angles sum. Each step = value + reason."}
      ],
      mistakes:["Circle theorems: answer without theorem name — loses reason marks","Co-interior angles: equal (wrong!) not supplementary","Polygon: using (n–2)×180 without ÷n for regular polygon","Proof: 'obviously' not accepted — must cite specific property"]
    },
    {id:"4.2",title:"Pythagoras & Trigonometry",
      boards:{AQA:"Embedded in coordinates/area. 3D Pythagoras. SOH CAH TOA. Exact values non-calc.",Edexcel:"Sine/cosine rule. 'Show angle = 47.2°'. Area = ½ab sinC independently.",OCR:"Bearings + trig combined. Prove right-angled via converse Pythagoras. 3D with pyramid."},
      analogy:{icon:"📐",title:"SOH CAH TOA + Decision Tree",lines:["Label relative to YOUR angle: O=Opposite, A=Adjacent, H=Hypotenuse","sin θ=O/H  cos θ=A/H  tan θ=O/A","Finding angle: θ = sin⁻¹(O/H)","WHICH RULE?","Right-angled triangle: Pythagoras or SOH CAH TOA","Non-right, 2 sides + included angle: Cosine rule","Non-right, angle + opposite side: Sine rule","Exact values: sin30=½, cos60=½, tan45=1, sin60=√3/2"]},
      markScheme:["SOH CAH TOA: M1 correct ratio, A1 angle/side","Cosine rule: M1 correct substitution, M1 cos(obtuse) negative, A1","3D trig: M1 for identifying 2D triangle, then standard marks","Non-calc: surd form required, not decimal"],
      questions:[
        {q:"Ladder 8m leans against wall. Foot 2.5m from base. Find angle with ground.",marks:2,diff:"Starter",ms:["M1: cosθ = 2.5/8","A1: 71.8°"],insight:"Ground=adjacent, ladder=hypotenuse → use cos. Identify the ratio BEFORE the calculator."},
        {q:"Triangle ABC: AB=7cm, BC=9cm, angle ABC=115°. Find AC to 3 s.f.",marks:3,diff:"Mid",ms:["M1: AC²=49+81–2(7)(9)cos115°","M1: cos(115°) is negative → 130+53.25","A1: 13.5cm"],insight:"cos(115°) is NEGATIVE. The – in the formula + negative cosine = positive addition. Catches 30% of students."},
        {q:"Pyramid: square base 10cm, slant edge 13cm, apex above centre.\na) Find height\nb) Angle between slant edge and base",marks:5,diff:"Killer",ms:["M1: half-diagonal=5√2","M1: h²=169–50=119","A1: h=10.9cm","M1: tanθ=√119/5√2","A1: 57.2°"],insight:"3D trig: find the 2D right-triangle. Centre to corner of square = half the diagonal. Two-stage Pythagoras."}
      ],
      mistakes:["Wrong side labelled 'opposite'","Cosine rule with obtuse: taking |cos| instead of negative value","Exact values: 0.707 not acceptable on non-calc paper (write √2/2)","3D: working in 3D directly instead of cross-sections"]
    },
    {id:"4.3",title:"Constructions & Loci",
      boards:{AQA:"Leave ALL construction arcs visible — erasing = zero marks. 'Shade region within 3cm of A and closer to B than C'. Scale drawings: show scale used.",Edexcel:"Combine perpendicular bisector with locus from a point. 'Locus equidistant from two lines' = angle bisector. Scale drawing + bearing combined.",OCR:"Construct triangle given three sides (ruler and compass only). 'Show by construction that angle=60°'. Describe the locus fully in words."},
      analogy:{icon:"🧭",title:"The 4 Key Constructions + Locus Rules",lines:["PERPENDICULAR BISECTOR of AB: compass >½AB. Arcs from A and B crossing above and below. Join intersections.","ANGLE BISECTOR at A: equal arcs on both arms of angle. Arcs inside. Join vertex to intersection.","60° ANGLE: use AB as radius. Arc from B. Where it crosses circle centred at A = equilateral triangle.","LOCUS RULES:","  Fixed distance from point → CIRCLE","  Equidistant from 2 points → PERPENDICULAR BISECTOR","  Equidistant from 2 lines → ANGLE BISECTOR","  Fixed distance from line → parallel line (+ semicircles at ends)"]},
      markScheme:["B1 correct construction with both pairs of arcs visible","Perpendicular bisector: both pairs of intersecting arcs required for M mark","Locus: B1 correct shape (circle/bisector), B1 correct position/radius","Scale drawing: M1 applying scale, A1 correct measurement to tolerance","Do NOT erase arcs — they are the examiner's evidence of method"],
      questions:[
        {q:"Using only a ruler and compass, construct the perpendicular bisector of line segment AB. Leave all construction marks visible.",marks:2,diff:"Starter",ms:["B1: arcs of equal radius from A and B, intersecting above and below AB","B1: line drawn through both intersection points"],insight:"Compass must be opened MORE than half the length of AB. Two arc intersections give the line. A ruler-drawn estimate — with no arcs — scores zero."},
        {q:"Points A and B are 8cm apart on a scale drawing where 1cm = 5m. Draw the locus of all points equidistant from A and B. Shade the region that is within 30m of A.",marks:4,diff:"Mid",ms:["M1: perpendicular bisector of AB constructed with arcs","B1: correct perpendicular bisector","M1: circle of radius 6cm (30÷5=6) centred on A","A1: correct region — left of bisector within circle (or right depending on setup)"],insight:"30m → 6cm on the drawing. Equidistant from A and B → perpendicular bisector. Within 30m of A → circle of radius 6cm. The required region satisfies BOTH conditions simultaneously."},
        {q:"A goat is tethered by a 6m rope to the corner P of a rectangular shed (8m×3m). Draw the full locus of points the goat can reach.",marks:4,diff:"Killer",ms:["M1: major arc, radius 6m, 270° centred on P","M1: minor arc radius 3m (6–3) around far short corner","M1: minor arc radius 2m (6–4) around far long corner — if rope reaches","A1: complete locus with correct arcs and no overlap into shed"],insight:"The shed blocks the rope. When rope wraps around the next corner, subtract the distance used: remaining rope = new radius. A single full circle ignores the obstacle and earns 1/4 at best."}
      ],
      mistakes:["Erasing construction arcs — immediate loss of all marks for that construction","Perpendicular bisector: compass not opened beyond half of AB — arcs don't cross","Angle bisector: drawing from midpoints of arms instead of from vertex via arc intersections","Rope around obstacle: using the original radius for all arcs instead of subtracting used length"]
    },
    {id:"4.4",title:"Bearings",
      boards:{AQA:"Always 3 figures, measured clockwise from North. Bearings + scale drawings. Back bearing = bearing ± 180°. State 'North at B' when finding return bearing.",Edexcel:"Bearings combined with sine/cosine rule. 'Find the bearing of Y from X'. Multi-leg journeys with Pythagoras.",OCR:"'Show that the return bearing is 247°'. Vector components from bearings. Explain method with diagrams."},
      analogy:{icon:"🧭",title:"3 Bearing Rules — Never Break Them",lines:["1. ALWAYS measure from NORTH","2. ALWAYS measure CLOCKWISE","3. ALWAYS give 3 digits: 005° not 5°, 090° not 90°","BACK BEARING (A from B, given B from A):","  If bearing < 180°: ADD 180°","  If bearing ≥ 180°: SUBTRACT 180°","COMBINED WITH TRIG: draw diagram with North lines at EACH point","North component = distance × cos(bearing angle from North)","East component  = distance × sin(bearing angle from North)"]},
      markScheme:["B1 for three-figure bearing notation — '73°' instead of '073°' loses the mark","M1 correct North line drawn at the second point for back bearing","A1 correct back bearing value","Trig combined: M1 triangle drawn, M1 correct trig rule, A1 answer","Scale: M1 scale applied to measurement, A1 answer within tolerance"],
      questions:[
        {q:"The bearing of B from A is 073°. Find the bearing of A from B.",marks:2,diff:"Starter",ms:["M1: 073+180=253","A1: 253°"],insight:"Back bearing: <180° so add 180°. Always check: if result >360° subtract 360°. Answer must have 3 digits — 253° not 253."},
        {q:"A ship sails 15km on bearing 040° from port P to harbour H. Find how far north and east of P the harbour is.",marks:3,diff:"Mid",ms:["M1: North component=15cos(40°)=11.5km","M1: East component=15sin(40°)=9.6km","A1: 11.5km north, 9.6km east"],insight:"Bearing 040° = 40° clockwise from North. Draw the right triangle. The North component is adjacent to the bearing angle → use cos. East is opposite → use sin."},
        {q:"Lighthouse L, ship A at bearing 065° and 15km from L, ship B at bearing 130° and 20km from L. Find the distance AB.",marks:5,diff:"Killer",ms:["M1: angle ALB=130°–65°=65°","M1: cosine rule: AB²=15²+20²–2(15)(20)cos65°","M1: AB²=225+400–253.6=371.4","A1: AB=√371.4","A1: AB≈19.3km"],insight:"Both bearings measured from the same North line at L — the angle between them is the included angle in triangle ALB. Cosine rule with included angle. cos(65°) is positive here."}
      ],
      mistakes:["Measuring anticlockwise instead of clockwise from North","2-figure bearings: 73° instead of 073°","Back bearing: measuring from the original North line at A instead of a new North line at B","Trig with bearings: confusing which component uses sine and which uses cosine"]
    },
    {id:"4.5",title:"Congruence & Similarity",
      boards:{AQA:"'Prove triangles ABC and DEF are congruent, stating the condition'. All 4 conditions assessed. Similar: find area and volume scale factors from given linear scale factor.",Edexcel:"'Show that triangles are similar'. Fractional scale factors. Area=k² × original area — must show k found first.",OCR:"'Prove congruence using SSS — state which sides are equal and why'. Volume scale factor from ratio of lengths: k³."},
      analogy:{icon:"🔍",title:"Congruent = Same Size. Similar = Same Shape.",lines:["CONGRUENCE — 4 sufficient conditions:","  SSS: all 3 sides equal","  SAS: 2 sides + included angle equal","  AAS (or ASA): 2 angles + corresponding side","  RHS: right angle + hypotenuse + 1 side","SIMILARITY: equal angles (AA is enough)","SCALE FACTORS — LENGTH k:","  Area scale factor = k²","  Volume scale factor = k³","  Always find k first, then apply k² or k³"]},
      markScheme:["Congruence: M1 each pair stated with reason, A1 condition named in full (SSS/SAS/AAS/RHS)","Similarity: M1 two pairs of equal angles with reasons, A1 'similar by AA' stated","Area: M1 finds k, M1 squares it, A1 correct area","Volume: M1 finds k, M1 cubes it, A1 correct volume","'State the condition' = must write condition name, not just values"],
      questions:[
        {q:"Two similar triangles. Smaller has sides 3, 4, 5 cm and area 6cm². The larger has longest side 15cm. Find the area of the larger triangle.",marks:3,diff:"Starter",ms:["M1: linear SF=15÷5=3","M1: area SF=3²=9","A1: 6×9=54cm²"],insight:"Always find the LINEAR scale factor first. Area scale factor = (linear SF)². The most common error is multiplying area by 3 (linear SF) instead of by 9 (area SF)."},
        {q:"Triangles ABC and DEF: angle A=angle D=90°, AB=6cm, DE=9cm, BC=10cm, EF=15cm. Prove the triangles are similar and find AC.",marks:5,diff:"Mid",ms:["M1: angle A=angle D=90° (given)","M1: AB/DE=6/9=2/3, BC/EF=10/15=2/3 — ratios equal","A1: similar by SSS similarity (all ratios equal)","M1: AC/DF=2/3, Pythagoras AC=8","A1: DF=12, AC=8cm confirmed"],insight:"Ratios equal but sides not equal → similar, not congruent. State the scale factor and all three ratio comparisons. For congruence all sides must be equal (not in ratio)."},
        {q:"A cone has radius 5cm and volume 300cm³. A mathematically similar cone has radius 8cm. Find its volume to 1 d.p.",marks:3,diff:"Killer",ms:["M1: linear SF=8÷5=1.6","M1: volume SF=1.6³=4.096","A1: 300×4.096=1228.8cm³"],insight:"Volume scale factor = (linear SF) CUBED. This is where marks are lost. Never use 1.6 directly for volume — cube it first. The calculation 300×4.096 is the A mark."}
      ],
      mistakes:["Area using linear SF directly instead of k²","Volume using k² instead of k³","Congruence proof: stating condition without giving reasons for equal sides/angles","Confusing similar (same shape) with congruent (same shape AND size)"]
    },
    {id:"4.6",title:"Transformations",
      boards:{AQA:"'Describe fully' — type + all required details. Enlargement: centre AND scale factor. Rotation: centre, angle, direction. Single mark lost per missing detail.",Edexcel:"Combined transformations: apply first, then second. Negative SF enlargement. 'Single transformation equivalent to'.",OCR:"Invariant points. 'Show that combined transformation is equivalent to a single transformation'. Describe fully with all details."},
      analogy:{icon:"🔄",title:"Describe Fully = State ALL Details",lines:["REFLECTION: equation of mirror line (e.g. y=x, x=2, y=–1)","ROTATION: centre (x,y) + angle + direction (clockwise or anticlockwise)","TRANSLATION: column vector only (not coordinates)","ENLARGEMENT: centre of enlargement + scale factor (SF)","  SF>1: larger.  0<SF<1: smaller.  SF negative: image on opposite side of centre","COMBINED: apply FIRST transformation to get image, THEN second to that image","Check: 'fully describe' = no detail omitted. 1 mark per missing detail."]},
      markScheme:["Translation: B1 correct column vector — must be column form, not (x,y)","Rotation: B1 each for centre, angle, direction — three separate details","Reflection: B1 for equation of line of symmetry","Enlargement: B1 centre correct, B1 SF correct (sign and magnitude)","'Describe fully': each missing detail costs a mark"],
      questions:[
        {q:"Triangle A has vertices (1,1), (3,1), (3,4). Translate triangle A by the vector  (-3 / 2).  State the new coordinates.",marks:2,diff:"Starter",ms:["M1: subtract 3 from all x-coordinates, add 2 to all y-coordinates","A1: (–2,3), (0,3), (0,6)"],insight:"Column vector: top = x change, bottom = y change. Negative top = move left. Positive bottom = move up. Apply to every vertex individually."},
        {q:"Describe fully the single transformation that maps triangle P with vertices (2,1),(4,1),(4,3) to triangle Q with vertices (–2,–1),(–4,–1),(–4,–3).",marks:3,diff:"Mid",ms:["M1: identify as rotation (each point maps to –1 × original)","B1: centre (0,0)","B1: rotation of 180° (direction not needed for 180°)"],insight:"Check: (2,1)→(–2,–1) = multiplied by –1. This is 180° rotation. Identify all details: type + centre + angle. For 180°, clockwise and anticlockwise give the same result."},
        {q:"Enlarge triangle T with vertices (1,1), (3,1), (1,4) by scale factor –2, centre (0,0). State the coordinates of the image.",marks:3,diff:"Killer",ms:["M1: multiply each coordinate by –2 (through the origin)","A1: (1,1)→(–2,–2), (3,1)→(–6,–2)","A1: (1,4)→(–2,–8)"],insight:"Negative SF through origin: multiply each coordinate by –2. The image appears on the OPPOSITE side of the centre and is larger (|SF|=2). Don't confuse this with a reflection."}
      ],
      mistakes:["Translation: using a coordinate pair (3,2) instead of a column vector","Rotation: omitting direction — clockwise or anticlockwise loses a mark (except 180°)","Enlargement: negative SF — not placing image on opposite side of centre","Describe fully: writing 'enlargement with scale factor 2' without the centre of enlargement"]
    },
    {id:"4.7",title:"Vectors",
      boards:{AQA:"AB⃗=b–a notation. 'Express in terms of p and q'. Prove parallel or collinear — must show scalar multiple relationship.",Edexcel:"Midpoints in proofs. OM⃗ where M midpoint of AB = ½(a+b). Position vectors vs displacement vectors distinction.",OCR:"'Show that A, B, C are collinear' — parallel vectors + common point. Division of line in given ratio. 'Find vector OX where X divides AB in ratio 2:1'."},
      analogy:{icon:"↗",title:"Vector Routes — Always Find a Path",lines:["GOLDEN RULE: AB⃗ = OB⃗ – OA⃗ = b – a","ROUTE: AC⃗ = AB⃗ + BC⃗ (head to tail)","REVERSE: BA⃗ = –AB⃗","PARALLEL VECTORS: one is a scalar multiple of the other","COLLINEAR: vectors between the points are parallel AND share a common point","MIDPOINT M of AB: OM⃗ = ½(a+b) where a=OA⃗, b=OB⃗","RATIO 1:2 along AB: OX⃗ = OA⃗ + ⅓AB⃗"]},
      markScheme:["Route: M1 valid path via known point, A1 simplified expression","Parallel: M1 vector expression, A1 identifies scalar multiple k, B1 conclusion stated","Collinear: M1 parallel vectors, A1 common point identified, A1 written conclusion","Midpoint: M1 ½(a+b), A1 correct simplified expression","Division: M1 fraction of AB vector, A1 correct position vector"],
      questions:[
        {q:"OA⃗ = a and OB⃗ = b. M is the midpoint of AB. Find OM⃗ in terms of a and b.",marks:2,diff:"Starter",ms:["M1: OM⃗=OA⃗+AM⃗=a+½(b–a)","A1: ½a+½b or ½(a+b)"],insight:"Route via A: OA then half of AB. AM⃗=½AB⃗=½(b–a). Expanding: a+½b–½a=½a+½b. Both equivalent forms accepted."},
        {q:"OA⃗=3p+q, OB⃗=p+5q. X divides AB in the ratio 1:3 from A. Find OX⃗ in terms of p and q.",marks:4,diff:"Mid",ms:["M1: AB⃗=OB⃗–OA⃗=(p+5q)–(3p+q)=–2p+4q","M1: AX⃗=¼AB⃗=¼(–2p+4q)=–½p+q","M1: OX⃗=OA⃗+AX⃗=(3p+q)+(–½p+q)","A1: 2½p+2q"],insight:"Ratio 1:3 from A means AX = ¼ of AB (since total parts = 4, AX = 1 part). ROUTE: OX = OA + AX. Express AX as ¼ of AB vector."},
        {q:"OA⃗=2a, OB⃗=6b, OC⃗=2a+4b. Prove that A, B and C are collinear.",marks:4,diff:"Killer",ms:["M1: AB⃗=6b–2a","M1: AC⃗=4b","M1: Show AB⃗ and BC⃗ are parallel — BC⃗=OC⃗–OB⃗=2a–2b... check against AB","A1: state 'AC and CB are parallel and share point C, therefore A, B, C collinear'"],insight:"To prove collinear: find two vectors between the three points and show they are scalar multiples. Then name the common point. Without explicitly naming the shared point and stating the conclusion, the proof is incomplete."}
      ],
      mistakes:["AB⃗=a–b instead of b–a (reversed direction)","Parallel proof: not writing the conclusion — 'therefore parallel' required","Collinear: showing parallel vectors without naming a common point","Midpoint: forgetting to halve — writing a+b instead of ½(a+b)"]
    },
    {id:"4.8",title:"Area & Perimeter",
      boards:{AQA:"Composite shapes. Sector area=(θ/360)πr². Reverse: find radius given area. 'Give answer in terms of π'.",Edexcel:"Shaded region (subtract circle from rectangle). 'Show that area=...' with full working. Non-calc: exact π answers.",OCR:"Arcs, sectors, segments. 'Find perimeter of the sector'. Annulus. Context-based compound shapes."},
      analogy:{icon:"📐",title:"The Area Toolkit — 8 Key Shapes",lines:["Rectangle:     A=l×w","Triangle:      A=½×b×h","Parallelogram: A=b×h","Trapezium:     A=½(a+b)h","Circle:        A=πr²    C=2πr","Sector:        A=(θ/360)×πr²","Arc length:    L=(θ/360)×2πr","COMPOUND: split → add/subtract areas","PERIMETER: add ALL outer edges + arcs"]},
      markScheme:["M1 correct formula with correct values substituted","Sector: M1 (θ/360)×πr², A1 correct value","'In terms of π': decimal loses all marks after this instruction","Perimeter: M1 arc length included correctly, A1 total","Compound: M1 correct shapes, M1 each area computed"],
      questions:[
        {q:"Find the area of a sector with radius 9 cm and angle 120°. Give your answer in terms of π.",marks:2,diff:"Starter",ms:["M1: (120/360)×π×9²","A1: 27π cm²"],insight:"Sector area=(angle/360)×πr². Fraction=120/360=1/3. Area=(1/3)×π×81=27π. 'In terms of π' = leave as 27π — writing 84.8... scores 0. Show the fraction simplification."},
        {q:"A shape consists of a rectangle 12cm×8cm with a semicircle removed from one of the shorter sides. Find the area to 3 s.f.",marks:4,diff:"Mid",ms:["M1: Rectangle=12×8=96cm²","M1: Semicircle radius=4, area=½×π×16=8π","M1: Shaded=96–8π","A1: 70.9cm²"],insight:"The shorter side is 8cm, so semicircle radius=4cm. Remove the semicircle: 96–8π=96–25.13...=70.87≈70.9cm². Show the subtraction step clearly — that's the M mark."},
        {q:"A sector OAB has radius 15cm and arc length 20π cm. Find: a) angle AOB,  b) area of the sector.",marks:5,diff:"Killer",ms:["M1: Arc=(θ/360)×2π×15=20π","M1: θ/360=20π/30π=2/3","A1: θ=240°","M1: Area=(240/360)×π×225=(2/3)×225π","A1: 150π cm²"],insight:"Arc length formula first: (θ/360)×2πr=20π → (θ/360)×30π=20π → θ/360=2/3 → θ=240°. Then area=(2/3)×π×225=150π. Leave in exact form — no need to compute."}
      ],
      mistakes:["Sector: using r² for arc length OR 2πr for area — swap the formulas","'In terms of π': writing a decimal instead of leaving in π form","Perimeter of sector: forgetting to add the two radii (only including the arc)","Composite: adding when asked to subtract a removed region"]
    },
    {id:"4.9",title:"Volume & Surface Area",
      boards:{AQA:"Volume and SA of prisms, cylinders, cones, spheres. 'Show that volume ≈ 300 cm³'. Formulae given on sheet.",Edexcel:"'Calculate total surface area of composite solid'. Sphere+cylinder. Exact answer in terms of π.",OCR:"Reverse: find height from volume. Volume of frustum by subtraction. 'Compare volumes of two containers'."},
      analogy:{icon:"📦",title:"Volume & Surface Area Toolkit",lines:["PRISM: V=cross-section area × length","CYLINDER: V=πr²h    SA=2πr²+2πrh","CONE: V=⅓πr²h      SA=πrl+πr²  (l=slant height)","SPHERE: V=4/3πr³    SA=4πr²","PYRAMID: V=⅓×base area×height","Slant height: l=√(r²+h²) from Pythagoras","'Curved SA' = exclude flat base(s)","COMPOSITE: compute each solid separately, add/subtract"]},
      markScheme:["M1 correct formula, M1 correct substitution, A1 answer","SA: include ALL faces unless 'curved' specified","Slant height: M1 Pythagoras, A1 correct l value","Composite: M1 each shape computed, A1 total","Exact form required when instruction given"],
      questions:[
        {q:"Find the volume of a cylinder with radius 6 cm and height 10 cm. Give your answer to 3 significant figures.",marks:2,diff:"Starter",ms:["M1: V=π×6²×10=360π","A1: 1130 cm³"],insight:"V=πr²h. Substitute: π×36×10=360π≈1131≈1130cm³. Show the substitution step — that's the M mark. If giving 3 s.f., check rounding: 1131 → 1130."},
        {q:"A cone has radius 5 cm and perpendicular height 12 cm. Find: a) slant height, b) total surface area. Give answers to 3 s.f.",marks:5,diff:"Mid",ms:["M1: l=√(5²+12²)=√169","A1: l=13cm","M1: SA=πrl+πr²=π×5×13+π×25=65π+25π=90π","A1: 283 cm²"],insight:"Slant height from Pythagoras: l=√(25+144)=13. Total SA = curved (πrl) + base (πr²). 'Total' means include the base. 'Curved surface area only' means πrl only."},
        {q:"A solid is made by placing a cone (radius 4cm, height 3cm) on top of a cylinder (radius 4cm, height 8cm). Find the total volume in terms of π.",marks:4,diff:"Killer",ms:["M1: Cylinder V=π×16×8=128π","M1: Cone V=⅓×π×16×3=16π","M1: Add volumes","A1: 144π cm³"],insight:"Composite solid: compute each separately, then add. Cylinder: πr²h=128π. Cone: ⅓πr²h=16π. Total=144π. Leave in exact form — no need to evaluate."}
      ],
      mistakes:["SA: forgetting to include the base(s) when 'total' is asked","Cone SA: using h instead of slant height l","Sphere SA: using πr² (circle area) instead of 4πr²","Composite: using total height for cylinder instead of just its portion"]
    },
    {id:"4.10",title:"Sine Rule & Cosine Rule",
      boards:{AQA:"Non-right-angled triangles: label sides a,b,c opposite angles A,B,C. Ambiguous case (two possible triangles) tested at Higher. Area = ½ab sinC.",Edexcel:"'Give your answer to 3 s.f.' on trig questions. Cosine rule for finding an angle: rearrange formula. Area formula for triangles without perpendicular height.",OCR:"'Find the largest angle' — use cosine rule, identify side opposite largest angle first. Bearing problems with sine/cosine rule. Full method marks for correct setup."},
      analogy:{icon:"📐",title:"Two Triangles — Two Rules",lines:["DECIDE: right angle? → SOH CAH TOA. No right angle? → Sine or Cosine rule","SINE RULE: a/sinA = b/sinB = c/sinC","  USE WHEN: angle+opposite side pair is known","  Finding ANGLE: sinA/a = sinB/b (flip the formula)","COSINE RULE: a² = b² + c² – 2bc cosA","  USE WHEN: SAS (two sides + included angle) or SSS (all three sides)","  Finding ANGLE: cosA = (b²+c²–a²) / 2bc","AREA: ½ab sinC  ←  USE when no perpendicular height given"]},
      markScheme:["Sine rule: M1 correct formula setup with substitution, A1 answer","Cosine rule: M1 correct formula, M1 correct substitution, A1 answer","Finding angle via cosine rule: M1 rearrangement to cosA=..., A1 angle","Area formula: M1 ½ab sinC, A1 correct answer","Ambiguous case: B1 identifying second solution (180°–first angle)","All answers to degree of accuracy specified"],
      questions:[
        {q:"In triangle ABC,  AB = 9 cm,  angle A = 48°,  angle B = 63°.  Find BC.",marks:3,diff:"Starter",ms:["M1: angle C = 180–48–63 = 69°","M1: BC/sin48 = 9/sin69","A1: BC = 9sin48°/sin69° = 7.15 cm"],insight:"Angle–side pair: angle A and its opposite side BC, angle B and opposite AC, angle C and opposite AB. Find angle C first (angles sum to 180°). Then set up: BC/sinA = AB/sinC. Always identify which angle faces which side."},
        {q:"Triangle PQR:  PQ = 7 cm,  PR = 11 cm,  angle P = 35°.  Find QR.",marks:4,diff:"Mid",ms:["M1: Cosine rule — two sides and included angle","M1: QR² = 7² + 11² – 2×7×11×cos35°","M1: = 49 + 121 – 154 × 0.8192 = 43.8","A1: QR = 6.62 cm"],insight:"SAS (side-angle-side) → cosine rule. The angle (35°) is BETWEEN the two sides — that's the cosine rule setup. Label: a=QR, b=11, c=7, A=35°. Substitute directly: a²=b²+c²–2bc cosA."},
        {q:"Triangle XYZ:  XY = 8 cm,  YZ = 13 cm,  XZ = 10 cm.  Find angle X, and hence find the area of the triangle.",marks:6,diff:"Killer",ms:["M1: cosX = (8²+10²–13²)/(2×8×10)","M1: = (64+100–169)/160 = –5/160","A1: angle X = cos⁻¹(–0.03125) = 91.8°","M1: Area = ½ × 8 × 10 × sin91.8°","A1: = 40 × 0.9995","A1: = 39.98 ≈ 40.0 cm²"],insight:"SSS → cosine rule rearranged. Negative cosine means the angle is obtuse (>90°) — not an error! Then area = ½ab sinC uses the two sides that make the angle (XY=8 and XZ=10) and the angle between them (X). Show every substitution."}
      ],
      mistakes:["Using sine rule when only sides known (SSS) — must use cosine rule","Cosine rule: forgetting the '–2bc cosA' term (writing a²=b²+c² instead)","Finding angle: forgetting to take cos⁻¹ (inverse) at the end","Area formula: using base × height instead of ½ab sinC when no perpendicular height given","Labelling: side a is opposite angle A — mismatching letters loses all M marks"]
    },
    {id:"4.11",title:"Arc Length & Sector Area",
      boards:{AQA:"Arc and sector as fractions of full circle. 'Give answer in terms of π'. Segment area = sector – triangle. Radian questions at Further only.",Edexcel:"Perimeter of sector = arc + two radii. 'Find the area of the shaded segment'. 'Exact answer' means leave π in.",OCR:"'Show that arc length = kπ'. Multi-step: find angle then arc. Compound shapes involving sectors and triangles."},
      analogy:{icon:"🥧",title:"Sector = Pizza Slice",lines:["Think of the full circle as a whole pizza.","Sector is a slice — its fraction is θ/360°","ARC LENGTH = (θ/360) × 2πr   ← fraction of circumference","SECTOR AREA = (θ/360) × πr²   ← fraction of circle area","PERIMETER of sector = arc + r + r  (two radii + arc)","SEGMENT = sector – triangle  ← remove the triangular bit","  Triangle area = ½r²sinθ  (using the sine area formula)","EXACT answer = leave π in — never use 3.14 or button value"]},
      markScheme:["M1 correct fraction (θ/360) applied to formula, A1 answer","Arc: M1 uses 2πr not πr²","Sector area: M1 uses πr² not 2πr","Perimeter: must include BOTH radii — arc only loses A mark","Segment: M1 correct sector area, M1 correct triangle area (½r²sinθ), A1 final","Exact: answer must contain π — decimal loses all A marks if 'exact' specified"],
      questions:[
        {q:"A sector has radius 9 cm and angle 80°. Find: a) the arc length,  b) the area of the sector.  Give answers to 3 s.f.",marks:4,diff:"Starter",ms:["M1: arc = (80/360) × 2π × 9 = 12.6 cm","A1: 12.6 cm","M1: area = (80/360) × π × 81 = 56.5 cm²","A1: 56.5 cm²"],insight:"Same fraction θ/360 in both formulas — just use it with the right formula (2πr for length, πr² for area). Arc uses the circumference formula, sector uses the circle area formula. Don't swap them."},
        {q:"A sector has radius 12 cm and arc length 10π cm. Find the angle of the sector, and hence find the area of the sector. Give your answer in terms of π.",marks:5,diff:"Mid",ms:["M1: 10π = (θ/360) × 2π × 12","M1: θ = (10π × 360)/(24π) = 150°","A1: 150°","M1: Area = (150/360) × π × 144","A1: 60π cm²"],insight:"Arc length equation has one unknown (θ) — rearrange. 10π=(θ/360)×24π → θ=150°. Then substitute into sector area. 'In terms of π' — cancel π from calculation: (150/360)×144π=60π."},
        {q:"A sector OAB has radius 8 cm and angle 120°. Find the area of the segment (the region between chord AB and arc AB). Give your answer to 3 s.f.",marks:5,diff:"Killer",ms:["M1: Sector area = (120/360)×π×64 = 64π/3","M1: Triangle area = ½×8²×sin120° = ½×64×(√3/2) = 16√3","M1: Segment = sector – triangle","A1: 64π/3 – 16√3","A1: 67.1 – 27.7 = 39.4 cm²"],insight:"Segment = sector area minus triangle OAB. Triangle uses ½r²sinθ — the radius is both sides with the sector angle between them. Sector: 64π/3≈67.1. Triangle: 16√3≈27.7. Segment≈39.4 cm²."}
      ],
      mistakes:["Arc length: using πr² instead of 2πr (area formula for length — biggest error)","Perimeter: giving arc length only, not adding the two radii","Segment: subtracting from circumference instead of sector area","Exact answer: multiplying out π or substituting 3.14 — automatic zero on A marks","Fraction: using r/360 or 2r/360 instead of θ/360"]
    },
    {id:"4.12",title:"3D Pythagoras & Trigonometry",
      boards:{AQA:"'Find length of space diagonal of cuboid'. Angle between line and horizontal plane. Two-step: find diagonal of face first, then use in 3D triangle.",Edexcel:"'Find angle that AF makes with the base'. Identify the right triangle in 3D — label clearly. 'Give answer to 1 d.p.'",OCR:"'Find angle between AH and plane ABCD in cuboid ABCDEFGH'. Pyramid problems: diagonal of base then height of apex. 'Show that length AG = √(a²+b²+c²)'."},
      analogy:{icon:"📦",title:"3D Problems → Flatten to 2D",lines:["TRICK: every 3D trig problem hides a 2D right triangle","STEP 1: Identify the line you need (space diagonal, slant edge)","STEP 2: Find the diagonal of the base face first using Pythagoras","STEP 3: Build a new right triangle using that diagonal + the height","STEP 4: Use Pythagoras or trig on THIS triangle","Cuboid a×b×c: space diagonal = √(a²+b²+c²)","Angle to horizontal: tan θ = height ÷ base diagonal","Always DRAW the hidden right triangle — label all sides"]},
      markScheme:["M1 for correct right triangle identified in 3D shape","M1 Pythagoras applied to face diagonal","M1 Pythagoras or trig applied to final 3D triangle","A1 correct answer to specified accuracy","Angle: M1 trig ratio correctly set up, M1 inverse trig, A1 angle","Partial credit: correct intermediate value earns M marks even if final wrong"],
      questions:[
        {q:"A cuboid has length 8 cm, width 6 cm, height 5 cm. Find the length of the space diagonal.",marks:3,diff:"Starter",ms:["M1: Base diagonal = √(8²+6²) = √100 = 10 cm","M1: Space diagonal = √(10²+5²) = √125","A1: 5√5 = 11.2 cm"],insight:"Two-step Pythagoras. First find the base diagonal (8–6–10 is a Pythagorean triple). Then use it with the height in a vertical right triangle. Space diagonal = √(8²+6²+5²) = √125 — but you must show both steps, not jump to the formula."},
        {q:"Cuboid ABCDEFGH: AB=10cm, BC=7cm, CG=4cm. Find the angle that AG makes with the base ABCD.",marks:4,diff:"Mid",ms:["M1: AC = √(10²+7²) = √149","M1: tan(angle AGC) = AG_vertical/AC — wait, tan(∠GAC) = GC/AC","M1: tan θ = 4/√149","A1: θ = tan⁻¹(4/√149) = 18.1°"],insight:"Angle to base = angle between AG and its projection on the base (AC). The triangle is GAC where GC=4 (vertical) and AC=√149 (base diagonal). tan θ = opposite/adjacent = 4/√149. Use inv tan for the angle."},
        {q:"A square-based pyramid has base side 10 cm and slant edge 13 cm. Find: a) the height of the pyramid,  b) the angle the slant edge makes with the base.",marks:6,diff:"Killer",ms:["M1: Half diagonal of base = ½√(10²+10²) = 5√2","M1: Height² = 13²–(5√2)² = 169–50 = 119","A1: Height = √119 = 10.9 cm","M1: cos(angle) = 5√2/13","A1: angle = cos⁻¹(5√2/13)","A1: = 52.7°"],insight:"The slant edge goes from apex to base corner. Its base is half the diagonal of the square (5√2, not 5). Build triangle: slant edge=13, base=5√2, height=√119. Angle to base: cos θ = base/slant = 5√2/13."}
      ],
      mistakes:["Using half the side length instead of half the diagonal for pyramid base","Not finding the base diagonal first — treating 3D directly","Angle to horizontal: using the wrong side in trig ratio","Forgetting to take the inverse (cos⁻¹, tan⁻¹) to find the angle","Cuboid diagonal: computing √(a²+b²) without adding c² — 2D Pythagoras only"]
    }
  ]},
  {id:5,code:"M5",label:"Probability",color:"#E74C3C",icon:"◈",topics:[
    {id:"5.1",title:"Probability & Tree Diagrams",
      boards:{AQA:"P(A and B). Without replacement. Show working at each branch.",Edexcel:"Frequency trees. 'Find P(exactly one success)'.",OCR:"Multi-outcome trees. Must multiply along, add across."},
      analogy:{icon:"🎲",title:"The Four Probability Rules",lines:["RULE 1 — AND: MULTIPLY probabilities","  Without replacement: adjust 2nd probability","RULE 2 — OR (mutually exclusive): ADD","RULE 3 — Complement: P(not A) = 1 – P(A)","  'At least one' = 1 – P(none)  ← fastest","RULE 4 — Conditional: P(A|B) = P(A∩B)/P(B)"]},
      markScheme:["Without replacement: M marks for adjusted denominators","'At least one': M1 for 1–P(none) approach","Tree diagram: M1 for any correct branch product","Conditional: divide by P(given condition), not total"],
      questions:[
        {q:"Bag: 4 red, 3 blue, 5 green. Two drawn without replacement. Find P(same colour).",marks:4,diff:"Mid",ms:["M1: P(RR)=4/12×3/11=12/132","M1: P(BB)=6/132","M1: P(GG)=20/132","A1: 38/132=19/66"],insight:"Three mutually exclusive cases → add (OR = add). Show each separately — 3 M marks for the 3 products."},
        {q:"P(rain)=0.35. P(cycles|no rain)=0.8. P(cycles|rain)=0.2. Find P(Tom cycles).",marks:3,diff:"Starter",ms:["M1: 0.35×0.2=0.07","M1: 0.65×0.8=0.52","A1: 0.59"],insight:"Two routes lead to cycling — add them. Each route: multiply along. Draw the tree for method marks."},
        {q:"120 students: 72 Maths, 58 Science, 35 both.\na) Venn diagram  b) P(Maths only)  c) P(Science | Maths)",marks:5,diff:"Killer",ms:["M1+A1: M only=37, S only=23, neither=25","A1: 37/120","M1: 35/72","A1: 35/72"],insight:"Conditional from Venn: 'given Maths' restricts to Maths circle (72 students). Of those, 35 study Science. No formula needed."}
      ],
      mistakes:["Without replacement: same denominator for both draws","P(A and B) = P(A)+P(B) — WRONG. That's OR.","Conditional: dividing by wrong total","Venn: 35 in both circles separately instead of intersection only"]
    },
    {id:"5.2",title:"Venn Diagrams & Set Notation",
      boards:{AQA:"A∩B=intersection, A∪B=union, A'=complement. Fill Venn from frequency data. P(A∩B) from completed diagram.",Edexcel:"Three-circle Venn diagrams. 'Find n(A∪B)'. Universal set ξ defined. Write values in all regions.",OCR:"'Shade region A'∩B'. Set builder notation. List elements of sets. 'Use a Venn diagram to find P(A|B)'."},
      analogy:{icon:"⭕",title:"Venn Notation — 5 Symbols to Master",lines:["A ∩ B = AND = intersection (middle only)","A ∪ B = OR  = union (everything in either)","A' = NOT A = complement (outside A in ξ)","ξ = universal set = everything in rectangle","n(A) = number of elements in set A","TO FILL A VENN DIAGRAM:","  1. Put intersection (middle) in first","  2. Subtract from each circle total","  3. Remaining = outside both = n(ξ)–n(A∪B)"]},
      markScheme:["B1 correct intersection value","B1 outer sections of each circle (after subtracting intersection)","B1 'outside both' value correct","Probability: M1 correct numerator, A1 fraction simplified","Set notation: ∩, ∪, ' — words not accepted"],
      questions:[
        {q:"30 students: 18 study French, 12 German, 7 both. Draw a Venn diagram. Find P(French only).",marks:4,diff:"Starter",ms:["B1: intersection=7","B1: French only=11, German only=5","B1: neither=30–23=7","A1: P(French only)=11/30"],insight:"Start with 7 in the middle. French circle: 18 total, 7 in overlap → 11 outside. German: 12–7=5 outside. Total accounted: 11+7+5=23. Neither: 30–23=7. Build inside-out."},
        {q:"ξ={1,2,...,10}, A={multiples of 2}, B={multiples of 3}. List A∩B and find P(A'∩B).",marks:4,diff:"Mid",ms:["M1: A={2,4,6,8,10}, B={3,6,9}","M1: A∩B={6}","M1: A'={1,3,5,7,9}, A'∩B={3,9}","A1: P(A'∩B)=2/10=1/5"],insight:"A'∩B means 'in B but NOT in A'. A'={1,3,5,7,9}. Intersect with B={3,6,9}: elements in both={3,9}. P=2/10=1/5. Always simplify probability fractions."},
        {q:"80 students: 45 do Maths (M), 38 English (E), 22 both M and E, 15 Science only, 5 all three, 8 E∩S only, 6 M∩S only. Find the number who study none of the three subjects.",marks:5,diff:"Killer",ms:["M1: M only=45–22–6–5=12","M1: E only=38–22–8–5=3","M1: All regions: 12+3+15+5+6+8+22=71","M1: Check total ≤80","A1: Neither=80–71=9"],insight:"Three-circle Venn: always start from the centre (all three=5), work outwards — subtract centre from each two-circle overlap, then subtract all overlaps from single-subject totals. Sum all regions, subtract from grand total for 'none'."}
      ],
      mistakes:["A∪B: counting only the outside parts, forgetting the intersection","Building Venn: putting full totals in circles instead of subtracting intersection first","Complement A': students think A' means elements from outside ξ — it just means not in A","Three circles: double-counting the triple intersection when filling two-circle overlaps"]
    },
    {id:"5.3",title:"Experimental Probability & Relative Frequency",
      boards:{AQA:"'Estimate probability from experiment'. Expected frequency=prob×trials. Compare experimental vs theoretical. 'How could the experiment be improved?'",Edexcel:"Spinner spun 200 times. Large samples give better estimates. 'Is the dice fair? Justify with results.'",OCR:"'Calculate relative frequency for each outcome'. Bias identification. 'Why might results differ from theoretical?'"},
      analogy:{icon:"🎯",title:"Experimental vs Theoretical Probability",lines:["THEORETICAL: what SHOULD happen (calculated)","EXPERIMENTAL: what DID happen (from data)","RELATIVE FREQUENCY = frequency ÷ total trials","MORE TRIALS → better estimate (less spread)","EXPECTED FREQUENCY = probability × n","  Fair dice, 600 rolls: expected 6s=(1/6)×600=100","BIAS: experimental ≠ theoretical by a large amount","  → either poor experiment OR the item is biased","IMPROVEMENT: increase n, remove identifiable bias source"]},
      markScheme:["Relative frequency: M1 division, A1 fraction or decimal","Expected frequency: M1 p×n, A1 correct value","Comparison: quote both values AND give verdict","'Is it fair?': calculate expected, compare, state conclusion with figures","Bias/improvement: contextual — not generic 'do more trials'"],
      questions:[
        {q:"A biased coin is flipped 400 times and lands heads 260 times. Estimate the probability of heads.",marks:2,diff:"Starter",ms:["M1: 260÷400","A1: 13/20  (or 0.65)"],insight:"Experimental probability=frequency÷total. 260÷400=0.65=13/20. This is an ESTIMATE — more trials give a more reliable estimate. Always simplify the fraction if possible."},
        {q:"A six-sided dice is rolled 300 times. The number 4 appears 65 times. Is there evidence the dice is biased toward 4? Justify.",marks:3,diff:"Mid",ms:["M1: Expected frequency=(1/6)×300=50","M1: Actual 65 vs expected 50","A1: 65/300=0.217 vs 1/6≈0.167 — notably higher, evidence of bias toward 4"],insight:"Compare actual with expected using numbers. 65 when 50 expected is a 30% excess — notable evidence of bias. State: '65 > expected 50, so there is evidence of bias.' Give verdict with figures."},
        {q:"A manufacturer tests 5,000 lightbulbs. 4,725 work. a) Estimate P(bulb fails). b) In a batch of 20,000, how many are expected to fail?",marks:4,diff:"Killer",ms:["M1: P(fails)=275÷5000","A1: 11/200  (0.055)","M1: 0.055×20000","A1: 1100 bulbs"],insight:"P(fails)=(5000–4725)/5000=275/5000=11/200=0.055. Expected failures in 20,000: 0.055×20,000=1100. The relative frequency from the sample scales directly — that's the power of large-sample estimation."}
      ],
      mistakes:["Using successes as the probability without dividing by total","Expected frequency: P÷n instead of P×n","'Is it biased?': saying 'yes' without computing expected value to compare","Improvement: 'more trials' without specifying why — need contextual justification"]
    },
    {id:"5.4",title:"Conditional Probability",
      boards:{AQA:"P(A|B)=P(A∩B)/P(B). Two-way tables. 'Given student is Year 11, find P(plays sport)'.",Edexcel:"Without replacement combined with conditional. 'Given first marble red, find P(second also red)'.",OCR:"Conditional from Venn. 'Given studies French, P(also German)?'. Tree diagrams with conditional branching."},
      analogy:{icon:"🔍",title:"Conditional Probability — Shrink the Sample Space",lines:["P(A|B) = 'probability of A GIVEN B happened'","Read | as 'given'","METHOD: RESTRICT to the condition first","  'Given it rained' → look only at rainy rows","  Total becomes the condition count, not grand total","FORMULA: P(A|B)=P(A∩B)/P(B)","FROM TABLE: numerator=both conditions met","  denominator=row/column total for given condition","INDEPENDENCE: P(A|B)=P(A) → knowing B doesn't change A"]},
      markScheme:["M1 restricted denominator (the condition count)","A1 correct fraction using conditional denominator","From table: M1 correct cell, A1 correct fraction","'Given that': wrong denominator (using grand total) = M0","Simplify to lowest terms for A mark","Independence check: P(A|B)=P(A) with explanation"],
      questions:[
        {q:"30 students: 12 boys, 18 girls. 5 boys and 7 girls wear glasses. A student is chosen at random. Given they wear glasses, find P(they are a boy).",marks:3,diff:"Starter",ms:["M1: Total wearing glasses=5+7=12","M1: P(boy|glasses)=5/12","A1: 5/12"],insight:"'Given they wear glasses' → restrict to the 12 wearers. Of those, 5 are boys. P=5/12. Using 30 as the denominator would give 5/30 — wrong. The 'given' always shrinks the denominator."},
        {q:"A bag has 4 red and 6 blue balls. Two drawn without replacement. Find P(second red | first was red).",marks:3,diff:"Mid",ms:["M1: After one red removed: 3 red, 6 blue, 9 total remain","A1: P(2nd red|1st red)=3/9","A1: =1/3"],insight:"'Given first was red' → update the bag. Now 9 balls remain, 3 are red. P=3/9=1/3. This is the second branch on the tree diagram. Full P(both red)=4/10×3/9=12/90=2/15."},
        {q:"Events A and B: P(A)=0.4, P(B)=0.5, P(A∩B)=0.2. Find P(A|B) and P(B|A). Are A and B independent? Justify.",marks:5,diff:"Killer",ms:["M1: P(A|B)=0.2÷0.5=0.4","A1: P(A|B)=0.4","M1: P(B|A)=0.2÷0.4=0.5","A1: P(B|A)=0.5","A1: P(A|B)=P(A)=0.4 → independent (knowing B doesn't change P(A))"],insight:"P(A|B)=P(A) means B's occurrence doesn't affect A's probability — that's the definition of independence. Also verify: P(A∩B)=P(A)×P(B)=0.4×0.5=0.2 ✓ — both methods confirm independence."}
      ],
      mistakes:["Using grand total as denominator instead of the condition group","P(A|B)=P(B|A) — they're generally NOT equal (prosecutor's fallacy)","Without replacement: using original bag size for second draw","Independence: saying 'yes' without showing P(A|B)=P(A) with calculation"]
    }
  ]},
  {id:6,code:"M6",label:"Statistics",color:"#3498DB",icon:"⊞",topics:[
    {id:"6.1",title:"Averages & Frequency Tables",
      boards:{AQA:"Estimated mean from grouped table — must use midpoints. Modal class. Median from cf graph.",Edexcel:"Reverse mean calculations. 'Mean of 5 numbers is 12, 6th added, mean becomes 11...'",OCR:"'Compare two datasets' — must reference average AND spread both. One missing = half marks."},
      analogy:{icon:"📊",title:"The Examiner's Language for Statistics",lines:["Mean: uses ALL data, affected by outliers","Median: middle value, NOT affected by outliers","Mode: most frequent — only for categorical data","COMPARING needs TWO statements:","1. Compare averages (quote specific values)","2. Compare spread (IQR or range) with context","One statement alone = half marks. Both = full marks."]},
      markScheme:["M1 correct midpoints used, M1 Σ(fx), A1 correct division","Modal class: state the interval, not the midpoint","Comparing: must quote specific values, not just 'Group A is better'","Median from cf: plot at UPPER class boundary, read at n/2"],
      questions:[
        {q:"Ages of 80 club members: 20–30: 12, 30–40: 25, 40–50: 28, 50–60: 15. Find estimated mean.",marks:3,diff:"Starter",ms:["M1: midpoints 25,35,45,55","M1: Σ(fx)=3260","A1: 40.75 years"],insight:"ESTIMATED mean = always midpoints, never boundaries. Show the Σ(fx) row — that's where M marks live."},
        {q:"Mean of 6 numbers is 8.5. Five are 7,9,11,4,12. Find the 6th.",marks:3,diff:"Mid",ms:["M1: total=51","M1: known sum=43","A1: 8"],insight:"Reverse mean: mean × n = total. Subtract known sum. Works every time."},
        {q:"Group A: median 62, IQR 26. Group B: median 58, IQR 40. Write a full statistical comparison.",marks:4,diff:"Killer",ms:["B1+B1: 'Group A higher median (62>58) — generally higher scores'","B1+B1: 'Group A smaller IQR (26<40) — more consistent scores'"],insight:"Each comparison: statistic named + values quoted + contextual interpretation. 'A is better' alone = 0."}
      ],
      mistakes:["Estimated mean: using boundaries instead of midpoints","Comparing: average only, no spread = half marks","Cumulative frequency: plotting at midpoint not upper boundary","Histograms: frequency = height (wrong!) should be area = height × width"]
    },
    {id:"6.2",title:"Histograms",
      boards:{AQA:"'Complete the histogram given frequency density column'. Calculate fd=f÷class width. Estimate frequency in subrange: fd × partial width.",Edexcel:"'Estimate the number of people with time between 25 and 40'. Mixed class widths. Find frequency from histogram by calculating area.",OCR:"'Complete the table using the histogram'. Proportion questions using areas. Comparing distributions using histograms."},
      analogy:{icon:"📊",title:"Histograms — AREA = Frequency, Never Height",lines:["KEY FORMULA: Frequency Density = Frequency ÷ Class Width","Reverse: Frequency = Frequency Density × Class Width","HEIGHT of bar = frequency density (NOT frequency)","AREA of bar = frequency (the actual count)","EQUAL CLASS WIDTHS: looks like a bar chart, but axis label is still 'fd'","UNEQUAL WIDTHS: MUST calculate fd — heights alone are meaningless","ESTIMATING IN RANGE: assume uniform distribution, use fd × partial width"]},
      markScheme:["M1 for fd=frequency÷class width seen or implied","B1 for each correct bar drawn to correct height","Reading histogram: M1 fd×class width, A1 correct frequency","Proportion: M1 partial area divided by total area, A1 correct value","All bars must originate from zero — no gaps between bars"],
      questions:[
        {q:"A frequency table shows: 10≤t<20, frequency 24. The class width is 10. Calculate the frequency density.",marks:1,diff:"Starter",ms:["B1: fd=24÷10=2.4"],insight:"Frequency density = frequency ÷ class width. The height of the bar on a histogram is 2.4, NOT 24. The area (2.4 × 10 = 24) gives back the frequency."},
        {q:"A histogram has bars: 0<t≤10 (fd=2), 10<t≤20 (fd=5), 20<t≤30 (fd=4), 30<t≤50 (fd=1.5). Find the total number of values.",marks:3,diff:"Mid",ms:["M1: frequency=fd×class width for each bar","M1: 20+50+40+30 (last bar: 1.5×20=30)","A1: total=140"],insight:"Each class width matters. The last bar has width 20, so its area = 1.5×20 = 30, not 1.5×10 = 15. Different widths = different multipliers."},
        {q:"The same histogram is used to estimate the frequency of values between t=22 and t=30. The bar 20<t≤30 has fd=4 and the bar 20<t≤30 spans 10 units. Estimate the frequency from t=22 to t=30.",marks:3,diff:"Killer",ms:["M1: identify bar 20<t≤30, total area=4×10=40","M1: proportion of bar from 22 to 30: width=8, area=4×8=32","A1: estimated frequency=32"],insight:"Assume uniform distribution within the class. The region 22<t≤30 is 8 units wide within a 10-unit bar. Frequency estimate = fd × partial width = 4×8 = 32."}
      ],
      mistakes:["Height = frequency (wrong — height = frequency DENSITY)","Not dividing by class width when building the histogram from a frequency table","Last bar has doubled width: forgetting to use 20 not 10 as the class width","Proportion: dividing frequency densities instead of areas"]
    },
    {id:"6.3",title:"Cumulative Frequency",
      boards:{AQA:"Plot at upper class boundary — NOT midpoint. Read at n/2, n/4, 3n/4. Compare distributions using both median and IQR. Construct box plots.",Edexcel:"'Estimate how many earn more than £35,000'. Box plot from cf graph. 'Draw and interpret' combined questions.",OCR:"'Draw a box plot from the cf graph'. Compare two distributions: must reference average AND spread with specific values."},
      analogy:{icon:"📈",title:"Cumulative Frequency — The Running Total",lines:["BUILD: add frequencies cumulatively from left to right","PLOT: each point at UPPER CLASS BOUNDARY (not midpoint!)","For n=80 students:","  Median: read at y=40 → x-value gives median","  Lower Quartile (LQ): read at y=20","  Upper Quartile (UQ): read at y=60","  IQR = UQ – LQ","ESTIMATING IN RANGE: cf(upper) – cf(lower) = frequency in that range","BOX PLOT: minimum, LQ, median, UQ, maximum"]},
      markScheme:["B1 each point correctly plotted at upper class boundary","Median: M1 reading at n/2, A1 correct value","IQR: M1 UQ–LQ, A1 correct","Box plot: B1 median and quartiles correct positions, B1 whiskers to min/max","Comparison: B1 each comparison — must quote specific values AND interpret in context"],
      questions:[
        {q:"60 students sat a test. Cumulative frequencies at boundaries: ≤20:4, ≤30:14, ≤40:32, ≤50:50, ≤60:60. Find the median and IQR.",marks:4,diff:"Starter",ms:["M1: Median at cf=30, read from graph","A1: Median≈40","M1: LQ at cf=15≈31, UQ at cf=45≈48","A1: IQR≈17"],insight:"n=60, so median at cf=30, LQ at cf=15, UQ at cf=45. Read from the smooth S-curve: across from y-axis to curve, then DOWN to x-axis. All three readings from the same graph."},
        {q:"Group A: median=52, IQR=24. Group B: median=48, IQR=16. Write a full statistical comparison.",marks:4,diff:"Mid",ms:["B1+B1: 'Group A has a higher median (52>48), suggesting generally higher test scores'","B1+B1: 'Group B has a smaller IQR (16<24), indicating more consistent results'"],insight:"Two full comparisons needed. Each requires: the statistical measure named + both values quoted + a contextual interpretation. 'Group A is better' earns 0. Quote the numbers."},
        {q:"A cumulative frequency graph shows 100 workers' salaries. At £28k the cf=20, at £42k the cf=68. Estimate the number earning between £28k and £42k.",marks:2,diff:"Killer",ms:["M1: cf(£42k)–cf(£28k)=68–20","A1: 48 workers"],insight:"Frequency in a range = upper cf – lower cf. Read the two y-values from the graph at those x-values and subtract. This is the single most tested skill on cumulative frequency graphs."}
      ],
      mistakes:["Plotting at midpoint instead of upper class boundary — shifts entire graph left","Median: reading at n, not n/2 (using total frequency instead of half)","IQR: giving UQ or LQ as the answer instead of the difference","Comparison: one statement only, or no values quoted — loses half the marks"]
    },
    {id:"6.4",title:"Scatter Graphs & Correlation",
      boards:{AQA:"'Describe the correlation'. Draw line of best fit through mean point. 'Explain why this prediction may not be reliable'.",Edexcel:"Calculate mean point (x̄,ȳ). Interpolation (reliable) vs extrapolation (unreliable). 'Comment on the validity of the prediction'.",OCR:"'State whether the relationship implies causation — explain'. Identify outliers and describe in context. 'Describe the correlation in context'."},
      analogy:{icon:"🎯",title:"Scatter Graphs — Correlation ≠ Causation",lines:["CORRELATION TYPES: strength + direction","  Strong positive: close to upward diagonal line","  Weak positive: loose scatter with upward trend","  No correlation: random scatter","  Negative: as one variable increases, the other decreases","LINE OF BEST FIT: equal points on each side, MUST pass through the mean point (x̄,ȳ)","INTERPOLATION: predicting within data range → reliable","EXTRAPOLATION: predicting outside data range → unreliable","CAUSATION: a third variable can cause both — correlation alone proves nothing"]},
      markScheme:["Describe: B1 for strength + direction — 'positive correlation' alone is only 1 mark","Line of best fit: B1 balanced about data points, B1 passes through mean point","Interpolation/reliability: 'within the range of the data' required for the mark","Causation: must use the word 'cause' or 'causation' — 'link' or 'correlation' alone is insufficient","Outlier: describe in context — not just 'it's far from the line'"],
      questions:[
        {q:"A scatter graph shows as hours of revision increase, test scores increase. Most points are close to the line of best fit. Describe the correlation.",marks:1,diff:"Starter",ms:["B1: strong positive correlation"],insight:"Two words are required: STRENGTH (strong/weak) and DIRECTION (positive/negative). 'Positive correlation' without 'strong' is only half an answer on most mark schemes."},
        {q:"The mean point of a scatter graph is (4.5, 62). Using the line of best fit, predict y when x=7. State whether this prediction is reliable.",marks:3,diff:"Mid",ms:["B1: line of best fit drawn through mean point (4.5, 62)","M1: read y at x=7 from the line","A1: stated prediction + 'x=7 is within the data range so this is interpolation — reliable'"],insight:"The mean point is the anchor for the line of best fit. Draw the line through it. Check x=7 is within the range of x-values in the data before claiming reliability."},
        {q:"A study finds a strong positive correlation between the number of fire engines at a fire and the damage caused. A journalist writes: 'More fire engines cause more damage'. Explain why this is incorrect.",marks:2,diff:"Killer",ms:["B1: correlation does not imply causation","B1: a third factor (size of fire) causes both — larger fires require more engines and also cause more damage"],insight:"The confounding variable is the key: fire size drives both variables. This is the 'causation vs correlation' distinction. Always look for the hidden third variable when correlation seems implausible."}
      ],
      mistakes:["'There is a correlation' without strength or direction — loses the mark","Line of best fit not passing through the mean point (x̄,ȳ)","Extrapolation described as reliable without acknowledging the data range limitation","Causation: saying 'it shows that X causes Y' — correlation alone never proves causation"]
    },
    {id:"6.5",title:"Sampling Methods & Bias",
      boards:{AQA:"Describe random, systematic, stratified, opportunity. Identify bias in a described method. 'Give one advantage of stratified over simple random'.",Edexcel:"Calculate stratified sample: '240 Yr10, 160 Yr11, sample of 50 needed — how many from each year?'",OCR:"'Criticise this method'. Response bias, self-selection. 'Design an unbiased survey'. Evaluate sampling frames."},
      analogy:{icon:"📋",title:"4 Sampling Methods — Know When to Use Each",lines:["RANDOM: every member equally likely","  Number all members → random number generator","SYSTEMATIC: every kth member (k=population÷sample)","  Random start between 1 and k, then add k each time","STRATIFIED: proportion from each subgroup","  Group sample=(group size/total)×sample size","  Best for comparing subgroups","OPPORTUNITY: whoever is available — most biased","BIAS: leading questions, self-selected responses,","  non-random selection, unrepresentative location"]},
      markScheme:["Describe: must include HOW — naming the method alone earns 0","Stratified: M1 (group/total)×sample, A1 each group's size rounded","Criticism: specific to the described method — 'it's biased' alone=0","Advantage: must compare to specific alternative","Total sample must equal required — check rounding"],
      questions:[
        {q:"A school has 180 Year 10 and 120 Year 11 students. A stratified sample of 60 is needed. How many from each year?",marks:3,diff:"Starter",ms:["M1: Year 10: (180/300)×60=36","M1: Year 11: (120/300)×60=24","A1: 36 from Y10, 24 from Y11  (check: 36+24=60 ✓)"],insight:"Stratified: sample proportions match population proportions. 180/300=3/5, so (3/5)×60=36. Check totals add to 60 — they must. If rounding creates mismatch, adjust the larger group."},
        {q:"A researcher surveys people leaving a sports centre to find out about the town's exercise habits. Identify one source of bias and explain how it affects the results.",marks:2,diff:"Mid",ms:["B1: Opportunity sample at a sports centre selects people who already exercise regularly","B1: Results will overestimate exercise levels in the general population — non-exercisers excluded"],insight:"Self-selection bias: people at a sports centre are not representative of the town. The sample is biased toward active people. Results will overestimate how much people exercise. Always explain the direction of bias."},
        {q:"A factory produces 5,000 items per day. A quality control manager wants a systematic sample of 50 items. Describe exactly how to carry out this sample.",marks:3,diff:"Killer",ms:["B1: k=5000÷50=100 (sample every 100th item)","B1: Use random number generator to select a random start n between 1 and 100","B1: Sample items n, n+100, n+200, ... continuing to n+4900"],insight:"Systematic sampling: k=population÷sample=100. Random start between 1 and k ensures it's not entirely predictable. Then every 100th item from that start. The method must be fully specified — just 'every 100th' without a random start isn't truly systematic."}
      ],
      mistakes:["Stratified: giving proportion not count (forgetting ×sample size)","Rounding: all groups rounded up → total exceeds required sample","Bias criticism: vague answer ('not representative') — must explain who is under/over-represented","Systematic: not randomising the start — must pick a random starting point within the first k items"]
    }
  ]}
];

// ═══ DERIVED DATA ════════════════════════════════════════════════════════════
const QUESTION_MAP = {};
MODULES.forEach(m=>m.topics.forEach(t=>t.questions.forEach((q,i)=>{
  QUESTION_MAP[`${t.id}:${i}`]={...q,qid:`${t.id}:${i}`,topicId:t.id,topicTitle:t.title,moduleId:m.id,moduleLabel:m.label,moduleColor:m.color};
})));
const ALL_QUESTIONS = Object.values(QUESTION_MAP);

function findModForTopic(topicId){return MODULES.find(m=>m.topics.some(t=>t.id===topicId));}

// ═══ CONSTANTS ═══════════════════════════════════════════════════════════════
const DIFF={
  Starter:{bg:'rgba(0,201,177,0.10)',c:'#00C9B1'},
  Mid:    {bg:'rgba(245,183,0,0.10)',c:'#F5B700'},
  Killer: {bg:'rgba(255,76,76,0.10)',c:'#FF4C4C'},
};
const TOPICS=[
  {module:"Number",id:"rounding",label:"Rounding & Bounds"},{module:"Number",id:"fractions",label:"Fractions"},
  {module:"Number",id:"percentages",label:"Percentages"},{module:"Number",id:"powers_surds",label:"Powers, Roots & Surds"},
  {module:"Number",id:"standard_form",label:"Standard Form"},{module:"Algebra",id:"expanding",label:"Expanding & Factorising"},
  {module:"Algebra",id:"equations",label:"Solving Equations"},{module:"Algebra",id:"sequences",label:"Sequences"},
  {module:"Algebra",id:"graphs",label:"Graphs & Functions"},{module:"Algebra",id:"inequalities",label:"Inequalities"},
  {module:"Ratio & Rates",id:"ratio",label:"Ratio"},{module:"Ratio & Rates",id:"proportion",label:"Direct & Inverse Proportion"},
  {module:"Ratio & Rates",id:"compound_measures",label:"Speed / Density / Pressure"},{module:"Ratio & Rates",id:"growth_decay",label:"Growth & Decay"},
  {module:"Geometry",id:"angles",label:"Angles & Circle Theorems"},{module:"Geometry",id:"area_volume",label:"Area, Perimeter & Volume"},
  {module:"Geometry",id:"trigonometry",label:"Pythagoras & Trigonometry"},{module:"Geometry",id:"vectors",label:"Vectors & Transformations"},
  {module:"Probability",id:"probability",label:"Probability & Tree Diagrams"},{module:"Statistics",id:"averages",label:"Averages & Frequency Tables"},
  {module:"Statistics",id:"histograms",label:"Histograms & Cumulative Frequency"},{module:"Statistics",id:"scatter",label:"Scatter Graphs & Sampling"},
];
const MCOLORS={Number:"#E8B84B",Algebra:"#4FC3A1","Ratio & Rates":"#E07B54",Geometry:"#9B59B6",Probability:"#E74C3C",Statistics:"#3498DB"};
const BCOLORS={AQA:"#1B2A4A",Edexcel:"#C0392B",OCR:"#0D6E72",'Edexcel IGCSE':"#7B2D8B"};

// ═══ ANIMATION STYLES ════════════════════════════════════════════════════════
function AnimStyles(){
  return(
    <style>{`
      @keyframes celebPop{from{opacity:0;transform:scale(0.92)}to{opacity:1;transform:scale(1)}}
      @keyframes celebFade{0%{opacity:1}70%{opacity:1}100%{opacity:0}}
      @keyframes fadeInUp{0%{transform:translateY(20px);opacity:0}100%{transform:translateY(0);opacity:1}}
      @keyframes ringFill{0%{stroke-dashoffset:var(--circ)}100%{stroke-dashoffset:var(--offset)}}
      @keyframes slideIn{0%{transform:translateX(-12px);opacity:0}100%{transform:translateX(0);opacity:1}}
      @keyframes pulseAmber{0%,100%{box-shadow:0 0 0 0 rgba(245,183,0,0.0)}50%{box-shadow:0 0 0 6px rgba(245,183,0,0.18)}}
      @keyframes dotPulse{0%,80%,100%{opacity:0.2}40%{opacity:1}}
      @keyframes spin{to{transform:rotate(360deg)}}
      @keyframes slideUp{0%{transform:translateY(30px);opacity:0}100%{transform:translateY(0);opacity:1}}
      @keyframes popIn{from{opacity:0;transform:scale(0.95)}to{opacity:1;transform:scale(1)}}
      *{-webkit-tap-highlight-color:transparent;box-sizing:border-box;}
      body{overflow-x:hidden;}
      @media(max-width:639px){
        button,a{min-height:40px;}
        input,textarea,select{font-size:16px!important;}
      }
    `}</style>
  );
}

// ═══ MASTERY RING ═════════════════════════════════════════════════════════════
function MasteryRing({ratio,color,size=52,stroke=4}){
  const r=(size-stroke*2)/2;
  const circ=2*Math.PI*r;
  const offset=circ-(ratio||0)*circ;
  return(
    <svg width={size} height={size} style={{transform:'rotate(-90deg)',flexShrink:0}}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={DS.bg.overlay} strokeWidth={stroke}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color||DS.accent.amber} strokeWidth={stroke}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        style={{transition:'stroke-dashoffset 0.8s ease'}}/>
    </svg>
  );
}

// ═══ PREDICTED GRADE ══════════════════════════════════════════════════════════
// Grade boundaries based on typical GCSE Maths Higher tier thresholds
const GRADE_BOUNDARIES=[
  {grade:'9',min:0.88,color:'#00C9B1'},{grade:'8',min:0.76,color:'#4CAF50'},
  {grade:'7',min:0.64,color:'#8BC34A'},{grade:'6',min:0.54,color:'#D4A017'},
  {grade:'5',min:0.44,color:'#FF9800'},{grade:'4',min:0.34,color:'#FF5722'},
  {grade:'3',min:0.24,color:'#F44336'},{grade:'U',min:0,color:'#666'},
];
function calcGrade(avg){return GRADE_BOUNDARIES.find(b=>avg>=b.min)||GRADE_BOUNDARIES[GRADE_BOUNDARIES.length-1];}
function nextGrade(avg){const idx=GRADE_BOUNDARIES.findIndex(b=>avg>=b.min);return idx>0?GRADE_BOUNDARIES[idx-1]:null;}

function PredictedGrade({perf}){
  const entries=Object.entries(perf).filter(([,p])=>p.total>0);
  if(!entries.length)return(
    <div style={{textAlign:'center',padding:'16px 12px'}}>
      <div style={{fontSize:44,fontWeight:900,color:DS.accent.amber,lineHeight:1}}>–</div>
      <div style={{fontSize:11,fontWeight:800,color:DS.text.secondary,marginTop:4}}>Predicted Grade</div>
      <div style={{fontSize:10,color:DS.text.muted,marginTop:2}}>Answer questions to unlock</div>
    </div>
  );
  const avg=entries.reduce((s,[,p])=>s+(p.correct/p.total),0)/entries.length;
  const current=calcGrade(avg);
  const next=nextGrade(avg);
  const pctToNext=next?Math.round(((avg-current.min)/(next.min-current.min))*100):100;
  // Find weakest topic to boost grade
  const weakest=entries.sort(([,a],[,b])=>(a.correct/a.total)-(b.correct/b.total))[0];
  const weakTopic=weakest?MODULES.flatMap(m=>m.topics).find(t=>t.id===weakest[0]):null;
  return(
    <div style={{padding:'14px 12px'}}>
      <div style={{display:'flex',alignItems:'center',gap:16,marginBottom:10}}>
        <div style={{textAlign:'center',flexShrink:0}}>
          <div style={{fontSize:52,fontWeight:900,color:current.color,lineHeight:1}}>{current.grade}</div>
          <div style={{fontSize:10,fontWeight:800,color:DS.text.secondary,marginTop:2}}>PREDICTED</div>
        </div>
        <div style={{flex:1}}>
          {next&&<>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
              <span style={{fontSize:11,color:DS.text.muted}}>Progress to grade <strong style={{color:next.color}}>{next.grade}</strong></span>
              <span style={{fontSize:11,fontWeight:700,color:next.color}}>{pctToNext}%</span>
            </div>
            <div style={{height:6,background:DS.bg.elevated,borderRadius:3,overflow:'hidden'}}>
              <div style={{height:'100%',width:`${pctToNext}%`,background:next.color,borderRadius:3,transition:'width 0.8s ease'}}/>
            </div>
          </>}
          <div style={{fontSize:10,color:DS.text.muted,marginTop:6}}>{Math.round(avg*100)}% avg · {entries.length} topic{entries.length!==1?'s':''} attempted</div>
        </div>
      </div>
      {next&&weakTopic&&<div style={{background:DS.bg.elevated,borderRadius:DS.radius.sm,padding:'8px 10px',fontSize:11,color:DS.text.secondary,borderLeft:`3px solid ${next.color}`}}>
        <strong style={{color:next.color}}>To reach grade {next.grade}:</strong> Focus on <strong style={{color:DS.text.primary}}>{weakTopic.title}</strong> — your weakest area
      </div>}
    </div>
  );
}

// ═══ STUDY MODE TOGGLE ════════════════════════════════════════════════════════
function StudyModeToggle({mode,setMode}){
  return(
    <div style={{display:'flex',gap:2,background:DS.bg.elevated,borderRadius:DS.radius.sm,padding:2,border:`1px solid ${DS.border}`}}>
      {[{id:'sprint',label:<><Zap size={12} strokeWidth={2}/> Sprint</>},{id:'deep',label:<><Target size={12} strokeWidth={2}/> Focus</>}].map(m=>(
        <button key={m.id} onClick={()=>setMode(m.id)} style={{padding:'4px 10px',borderRadius:6,border:'none',fontSize:11,fontWeight:700,cursor:'pointer',background:mode===m.id?DS.accent.amber:'transparent',color:mode===m.id?DS.bg.base:DS.text.secondary,transition:DS.tr}}>{m.label}</button>
      ))}
    </div>
  );
}

// ═══ CELEBRATION OVERLAY ══════════════════════════════════════════════════════
function Celebration({data,onDone}){
  useEffect(()=>{const t=setTimeout(onDone,2400);return()=>clearTimeout(t);},[]);
  if(!data)return null;
  return(
    <div style={{position:'fixed',inset:0,zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',pointerEvents:'none',animation:'celebFade 2.4s forwards',background:'rgba(0,0,0,0.4)'}}>
      <div style={{background:DS.bg.elevated,borderRadius:DS.radius.xl,padding:'28px 40px',textAlign:'center',boxShadow:DS.shadow,animation:'celebPop 0.5s ease-out',border:`1.5px solid ${DS.borderHi}`}}>
        <div style={{fontSize:56,marginBottom:8}}>{data.icon}</div>
        <div style={{fontSize:22,fontWeight:900,color:DS.accent.amber,marginBottom:6}}>{data.title}</div>
        <div style={{fontSize:14,color:DS.text.secondary}}>{data.body}</div>
      </div>
    </div>
  );
}

// ═══ GAMIFICATION BAR ════════════════════════════════════════════════════════
function GamificationBar({xp}){
  const lvl=getLevel(xp);
  const next=LEVELS.find(l=>l.min>xp);
  const pct=next?Math.round(((xp-lvl.min)/(next.min-lvl.min))*100):100;
  const streak=getStreakData();
  return(
    <div style={{background:DS.bg.surface,borderRadius:DS.radius.md,padding:'10px 14px',border:`1px solid ${DS.border}`,display:'flex',alignItems:'center',gap:10}}>
      <div style={{display:'flex',alignItems:'center',gap:8,minWidth:0,flex:1}}>
        <span style={{fontSize:20,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center'}}><LevelIcon name={lvl.name} size={20} color={lvl.color}/></span>
        <div style={{minWidth:0}}>
          <div style={{fontSize:12,fontWeight:800,color:DS.text.primary,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{lvl.name} · {xp} XP</div>
          <div style={{fontSize:9,color:DS.text.muted}}>{next?`${next.min-xp} XP to ${next.name}`:<><Trophy size={10} strokeWidth={2} style={{display:'inline',verticalAlign:'middle'}}/> Max level</>}</div>
        </div>
      </div>
      <div style={{flex:2,minWidth:60}}>
        <div style={{background:DS.bg.elevated,borderRadius:4,height:6,overflow:'hidden'}}>
          <div style={{height:'100%',borderRadius:4,background:`linear-gradient(90deg,${DS.accent.amber},${DS.accent.teal})`,width:`${pct}%`,transition:'width 0.6s ease'}}/>
        </div>
        <div style={{fontSize:9,color:DS.text.muted,marginTop:2,textAlign:'right'}}>{pct}%</div>
      </div>
      <div style={{display:'flex',alignItems:'center',gap:4,flexShrink:0}}>
        <span style={{display:'flex',alignItems:'center'}}><Flame size={16} strokeWidth={2} color={DS.accent.red}/></span>
        <div>
          <div style={{fontSize:13,fontWeight:800,color:DS.text.primary,lineHeight:1}}>{streak.current}</div>
          <div style={{fontSize:9,color:DS.text.muted}}>streak</div>
        </div>
      </div>
    </div>
  );
}

// ═══ PERSONALISED HERO ════════════════════════════════════════════════════════
function PersonalisedHero({onNavigate}){
  const profile=lsGet('lumora_profile',null);
  const perf=lsGet('gcse_perf',{});
  const streak=getStreakData();
  const xp=getXP();
  const lvl=getLevel(xp);
  const weeklyStats=getWeeklyStats();
  const [shareLoading,setShareLoading]=useState(false);

  // Exam countdown
  const days=profile?.examDate
    ?Math.max(0,Math.round((new Date(profile.examDate)-Date.now())/86400000))
    :null;

  // Grade calculation — uses shared GRADE_BOUNDARIES thresholds
  const perfEntries=Object.values(perf).filter(p=>p.total>0);
  const totalQsDone=perfEntries.reduce((s,p)=>s+p.total,0);
  const avg=perfEntries.length>0
    ?perfEntries.reduce((s,p)=>s+p.correct/p.total,0)/perfEntries.length
    :null;
  const avgPct=avg!==null?Math.round(avg*100):null;
  const currentBnd=avg!==null?calcGrade(avg):null;
  const currentGrade=currentBnd?.grade||null;
  const nextBnd=avg!==null?nextGrade(avg):null;
  const gapToNext=nextBnd&&avg!==null?Math.round((nextBnd.min-avg)*100):0;
  const gradeColor=currentBnd?.color||DS.text.muted;

  // Today's focus: due topics first, then weakest
  const allTopics=MODULES.flatMap(m=>m.topics.map(t=>({...t,moduleColor:m.color})));
  const dueTopicIds=[...new Set(getDueIds().map(id=>QUESTION_MAP[id]?.topicId).filter(Boolean))];
  const weakTopics=allTopics
    .map(t=>({...t,score:perf[t.id]?.total>0?perf[t.id].correct/perf[t.id].total:null}))
    .filter(t=>t.score!==null)
    .sort((a,b)=>a.score-b.score);
  const focusIds=[...new Set([...dueTopicIds,...weakTopics.map(t=>t.id)])].slice(0,2);
  const focusTopics=focusIds.map(id=>allTopics.find(t=>t.id===id)).filter(Boolean);
  const displayTopics=focusTopics.length>0?focusTopics:allTopics.slice(0,2);
  const weakestForGrade=weakTopics[0];
  const xpThisWeek=Math.max(0,xp-weeklyStats.xpStart);

  return(
    <div style={{background:DS.bg.surface,borderRadius:DS.radius.xl,border:`1px solid ${DS.border}`,overflow:'hidden',boxShadow:DS.shadow,marginBottom:16}}>
      {/* Gold-teal gradient top line */}
      <div style={{height:3,background:`linear-gradient(90deg,${DS.accent.amber},${DS.accent.teal})`}}/>
      <div style={{padding:'16px 18px'}}>

        {/* Row 1: greeting + exam countdown */}
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:16,gap:10}}>
          <div>
            <div style={{fontSize:19,fontWeight:900,color:DS.text.primary,lineHeight:1.1}}>
              {profile?.name?`Hi, ${profile.name} 👋`:'Welcome back 👋'}
            </div>
            <div style={{fontSize:11,color:DS.text.muted,marginTop:3,display:'flex',alignItems:'center',gap:4}}><LevelIcon name={lvl.name} size={12} color={lvl.color}/> {lvl.name} · {xp} XP</div>
          </div>
          {days!==null?(
            <div style={{background:DS.bg.elevated,borderRadius:DS.radius.md,padding:'8px 14px',border:`1px solid ${DS.border}`,textAlign:'center',flexShrink:0}}>
              <div style={{fontSize:24,fontWeight:900,color:DS.accent.amber,lineHeight:1}}>{days}</div>
              <div style={{fontSize:9,color:DS.text.muted,fontWeight:700,textTransform:'uppercase',letterSpacing:0.5}}>days to exam</div>
              {profile?.board&&<div style={{fontSize:9,color:DS.text.secondary,marginTop:1}}>{profile.board}</div>}
            </div>
          ):(
            <div style={{background:DS.accent.amberDim,borderRadius:DS.radius.md,padding:'8px 12px',border:`1px solid ${DS.accent.amber}33`,fontSize:11,color:DS.accent.amber,fontWeight:700,flexShrink:0}}>
              <Calendar size={13} strokeWidth={2} style={{display:'inline',verticalAlign:'middle',marginRight:4}}/> Set exam date
            </div>
          )}
        </div>

        {/* Row 2: Predicted Grade + Weekly Snapshot */}
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
          {/* Predicted Grade */}
          <div style={{background:DS.bg.elevated,borderRadius:DS.radius.md,padding:'12px 14px',border:`1px solid ${DS.border}`}}>
            <div style={{fontSize:9,fontWeight:700,color:DS.text.muted,textTransform:'uppercase',letterSpacing:1,marginBottom:6}}>Predicted Grade</div>
            {currentGrade?(
              <>
                <div style={{fontSize:36,fontWeight:900,color:gradeColor,lineHeight:1}}>Grade {currentGrade}</div>
                <div style={{fontSize:10,color:DS.text.muted,marginTop:4}}>{avgPct}% avg · {perfEntries.length} topics</div>
                {gapToNext>0&&weakestForGrade&&nextBnd&&(
                  <div style={{fontSize:9,color:DS.text.secondary,marginTop:5,lineHeight:1.4,borderTop:`1px solid ${DS.border}`,paddingTop:5}}>
                    +{gapToNext}% in <span style={{color:DS.accent.amber,fontWeight:700}}>{weakestForGrade.title.split(' ').slice(0,2).join(' ')}</span> → Grade {nextBnd.grade}
                  </div>
                )}
                {currentGrade==='9'&&<div style={{fontSize:9,color:DS.accent.teal,marginTop:5,fontWeight:700,display:'flex',alignItems:'center',gap:3}}><Trophy size={10} strokeWidth={2}/> Maximum grade!</div>}
              </>
            ):(
              <>
                <div style={{fontSize:36,fontWeight:900,color:DS.text.muted,lineHeight:1}}>—</div>
                <div style={{fontSize:10,color:DS.text.muted,marginTop:4,lineHeight:1.5}}>
                  {totalQsDone<5?`Answer ${5-totalQsDone} more questions to unlock`:'Complete topics to see your grade'}
                </div>
              </>
            )}
          </div>

          {/* Weekly Snapshot */}
          <div style={{background:DS.bg.elevated,borderRadius:DS.radius.md,padding:'12px 14px',border:`1px solid ${DS.border}`,display:'flex',flexDirection:'column'}}>
            <div style={{fontSize:9,fontWeight:700,color:DS.text.muted,textTransform:'uppercase',letterSpacing:1,marginBottom:10}}>This Week</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:4,flex:1}}>
              {[{icon:<FileText size={14} strokeWidth={2}/>,val:weeklyStats.qCount,label:'Qs'},{icon:<Flame size={14} strokeWidth={2}/>,val:streak.current,label:'Streak'},{icon:<Zap size={14} strokeWidth={2}/>,val:xpThisWeek,label:'XP'}].map(s=>(
                <div key={s.label} style={{textAlign:'center'}}>
                  <div style={{fontSize:12,marginBottom:2,display:'flex',justifyContent:'center'}}>{s.icon}</div>
                  <div style={{fontSize:20,fontWeight:900,color:DS.accent.amber,lineHeight:1}}>{s.val}</div>
                  <div style={{fontSize:9,color:DS.text.muted,fontWeight:600,marginTop:1}}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Row 3: Today's Focus CTA */}
        <div style={{background:DS.bg.elevated,borderRadius:DS.radius.md,padding:'12px 14px',border:`1px solid ${DS.border}`,marginBottom:10}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8,gap:8,flexWrap:'wrap'}}>
            <div>
              <div style={{fontSize:9,fontWeight:700,color:DS.accent.amber,textTransform:'uppercase',letterSpacing:1.5,marginBottom:3}}>Today's Focus</div>
              <div style={{fontSize:13,fontWeight:700,color:DS.text.primary}}>{displayTopics.map(t=>t.title).join(' · ')}</div>
            </div>
            {dueTopicIds.length>0&&(
              <div style={{fontSize:9,background:DS.accent.amberDim,color:DS.accent.amber,padding:'3px 8px',borderRadius:4,fontWeight:700,border:`1px solid ${DS.accent.amber}33`,flexShrink:0}}>
                {dueTopicIds.length} due for review
              </div>
            )}
          </div>
          <button onClick={()=>displayTopics[0]&&onNavigate(displayTopics[0].id)}
            style={{width:'100%',padding:'11px 0',borderRadius:DS.radius.sm,border:'none',background:`linear-gradient(135deg,${DS.accent.amber},#D4A000)`,color:DS.bg.base,fontWeight:900,fontSize:13,cursor:'pointer',transition:DS.tr,boxShadow:`0 2px 14px ${DS.accent.amber}33`}}>
            Start Today's Session →
          </button>
        </div>

        {/* Share Progress Report button */}
        <button onClick={async()=>{
          setShareLoading(true);
          const tab=window.open('','_blank');
          if(!tab){setShareLoading(false);alert('Pop-ups are blocked. Please allow pop-ups for this site, then try again.');return;}
          tab.document.write('<html><body style="font-family:\'Segoe UI\',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f0ede8;color:#1a2744"><div style="text-align:center"><div style="font-size:40px;margin-bottom:14px">📐</div><h2 style="font-weight:800;margin-bottom:6px">Generating Progress Report…</h2><p style="color:#718096">This takes a few seconds</p></div></body></html>');
          try{
            const allTopics=MODULES.flatMap(m=>m.topics);
            const scored=allTopics
              .map(t=>({...t,score:perf[t.id]?.total>=2?perf[t.id].correct/perf[t.id].total:null}))
              .filter(t=>t.score!==null)
              .sort((a,b)=>b.score-a.score);
            const strengths=scored.slice(0,3);
            const weaknesses=[...scored].sort((a,b)=>a.score-b.score).slice(0,3);
            const totalCorrect=perfEntries.reduce((s,p)=>s+p.correct,0);
            const aiResult=await aiProgressReport({
              name:profile?.name||'Student',
              grade:currentGrade?`Grade ${currentGrade}`:'not yet determined',
              avgPct:avgPct||0,
              strongestTopic:strengths[0]?.title||'not yet assessed',
              strongestPct:strengths[0]?Math.round(strengths[0].score*100):0,
              weakestTopic:weaknesses[0]?.title||'not yet assessed',
              weakestPct:weaknesses[0]?Math.round(weaknesses[0].score*100):0,
              totalQs:totalQsDone,
              board:profile?.board||'GCSE'
            });
            const html=buildReportHTML({
              profile,
              grade:currentGrade?`Grade ${currentGrade}`:'—',
              avgPct,
              totalQs:totalQsDone,
              totalCorrect,
              streakCount:streak.current,
              timeMinutes:totalQsDone*2,
              strengths,
              weaknesses,
              aiSummary:aiResult.summary,
              aiActions:aiResult.actions,
              days
            });
            if(tab){tab.document.open();tab.document.write(html);tab.document.close();}
          }catch(e){
            if(tab)tab.document.write(`<html><body style="font-family:sans-serif;padding:40px;color:#1a2744"><h2>Error generating report</h2><p>${e.message}</p></body></html>`);
          }finally{setShareLoading(false);}
        }}
          style={{width:'100%',padding:'10px 0',borderRadius:DS.radius.sm,border:`1px solid ${DS.border}`,background:'transparent',color:DS.text.secondary,fontWeight:700,fontSize:12,cursor:shareLoading?'wait':'pointer',transition:DS.tr,display:'flex',alignItems:'center',justifyContent:'center',gap:6,opacity:shareLoading?0.6:1}}>
          {shareLoading?<><Loader2 size={14} strokeWidth={2} style={{animation:'spin 0.8s linear infinite'}}/> Generating report…</>:<><BarChart2 size={14} strokeWidth={2} style={{display:'inline',verticalAlign:'middle',marginRight:4}}/> Share Progress Report</>}
        </button>

      </div>
    </div>
  );
}

// ═══ WEEKLY GOAL BAR ══════════════════════════════════════════════════════════
function WeeklyGoalBar(){
  const d=getWeeklyData();
  const goal=5;
  const today=new Date().getDay(); // 0=Sun,6=Sat
  const isWeekend=today===0||today===6;
  const nudge=isWeekend&&d.count===goal-1;
  return(
    <div style={{background:DS.bg.surface,borderRadius:DS.radius.md,padding:'12px 14px',border:`1px solid ${DS.border}`,marginBottom:14}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
        <div style={{fontSize:11,fontWeight:800,color:DS.accent.amber,display:'flex',alignItems:'center',gap:4}}><Zap size={14} strokeWidth={2}/> Weekly Goal</div>
        <div style={{fontSize:12,fontWeight:900,color:d.count>=goal?DS.accent.teal:DS.text.primary}}>
          {d.count}<span style={{color:DS.text.muted,fontWeight:400}}>/{goal} days</span>
        </div>
      </div>
      <div style={{display:'flex',gap:4,marginBottom:nudge||d.count>=goal?8:0}}>
        {Array.from({length:goal},(_,i)=>(
          <div key={i} style={{flex:1,height:5,borderRadius:3,background:i<d.count?DS.accent.amber:DS.bg.elevated,transition:'background 0.3s ease'}}/>
        ))}
      </div>
      {nudge&&<div style={{fontSize:11,color:DS.accent.amber,fontWeight:700,display:'flex',alignItems:'center',gap:4}}>One more to hit your weekly goal! <Target size={14} strokeWidth={2}/></div>}
      {d.count>=goal&&<div style={{fontSize:11,color:DS.accent.teal,fontWeight:700,display:'flex',alignItems:'center',gap:4}}><Check size={14} strokeWidth={2.5}/> Weekly goal smashed! <Trophy size={14} strokeWidth={2}/></div>}
    </div>
  );
}

// ═══ ONBOARDING ════════════════════════════════════════════════════════════════
function Onboarding({onComplete}){
  const [step,setStep]=useState(1);
  const [profile,setProfile]=useState({name:'',board:'AQA',grade:'7',examDate:'',weaknesses:[]});
  const boards=['AQA','Edexcel','OCR','Edexcel IGCSE'];
  const grades=['9','8','7','6','5','4'];
  const allTopics=MODULES.flatMap(m=>m.topics.map(t=>({id:t.id,title:t.title,module:m.label,color:m.color})));
  const update=(k,v)=>setProfile(p=>({...p,[k]:v}));
  const toggleWeak=(id)=>{
    const cur=profile.weaknesses;
    if(cur.includes(id)){update('weaknesses',cur.filter(x=>x!==id));}
    else if(cur.length<3){update('weaknesses',[...cur,id]);}
  };
  const [now]=useState(Date.now);
  const weeks=profile.examDate?Math.max(0,Math.round((new Date(profile.examDate)-now)/(1000*60*60*24*7))):null;
  const canNext=(
    (step===1&&profile.name.trim().length>=2)||
    step===2||step===3||
    step===4||
    (step===5&&profile.weaknesses.length>0)
  );
  const handleNext=()=>{
    if(step<5){setStep(s=>s+1);}
    else{lsSet('lumora_profile',{...profile,createdAt:new Date().toISOString()});track('onboarding_completed',{board:profile.board,grade:profile.grade,weaknessCount:profile.weaknesses.length});onComplete(profile);}
  };
  return(
    <div style={{fontFamily:"'Segoe UI',sans-serif",minHeight:'100vh',background:DS.bg.base,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{width:'100%',maxWidth:460,background:DS.bg.surface,borderRadius:DS.radius.xl,overflow:'hidden',boxShadow:DS.shadow,border:`1px solid ${DS.border}`}}>
        <div style={{height:4,background:DS.bg.elevated}}><div style={{height:'100%',background:DS.accent.amber,width:`${(step/5)*100}%`,transition:'width 0.4s ease'}}/></div>
        <div style={{padding:'28px 28px 24px'}}>
          <div style={{fontSize:10,fontWeight:800,color:DS.accent.amber,letterSpacing:2,textTransform:'uppercase',marginBottom:16}}>Step {step} of 5</div>
          {step===1&&(
            <div style={{animation:'fadeInUp 0.3s ease'}}>
              <div style={{fontSize:36,marginBottom:8}}>👋</div>
              <div style={{fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:6}}>What's your name?</div>
              <div style={{fontSize:13,color:DS.text.secondary,marginBottom:20}}>Let's personalise your experience</div>
              <input value={profile.name} onChange={e=>update('name',e.target.value)} placeholder="e.g. Alex" autoFocus style={{width:'100%',padding:'14px 16px',borderRadius:DS.radius.md,border:`1.5px solid ${DS.border}`,fontSize:16,fontFamily:'inherit',outline:'none',boxSizing:'border-box',color:DS.text.primary,background:DS.bg.elevated}} onFocus={e=>e.target.style.borderColor=DS.accent.amber} onBlur={e=>e.target.style.borderColor=DS.border}/>
            </div>
          )}
          {step===2&&(
            <div style={{animation:'fadeInUp 0.3s ease'}}>
              <div style={{fontSize:36,marginBottom:8,display:'flex',justifyContent:'center'}}><ClipboardList size={36} strokeWidth={1.5} color={DS.accent.amber}/></div>
              <div style={{fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:6}}>Which exam board?</div>
              <div style={{fontSize:13,color:DS.text.secondary,marginBottom:20}}>We'll highlight board-specific tips for you</div>
              <div style={{display:'grid',gap:10}}>
                {boards.map(b=>(
                  <button key={b} onClick={()=>update('board',b)} style={{padding:'16px 20px',borderRadius:DS.radius.md,border:`1.5px solid ${profile.board===b?DS.accent.amber:DS.border}`,background:profile.board===b?DS.accent.amberDim:DS.bg.elevated,color:profile.board===b?DS.accent.amber:DS.text.primary,fontWeight:700,fontSize:14,cursor:'pointer',textAlign:'left',display:'flex',alignItems:'center',justifyContent:'space-between',transition:DS.tr}}>
                    {b}{profile.board===b&&<span style={{color:DS.accent.amber,display:'flex',alignItems:'center'}}><Check size={14} strokeWidth={2.5}/></span>}
                  </button>
                ))}
              </div>
            </div>
          )}
          {step===3&&(
            <div style={{animation:'fadeInUp 0.3s ease'}}>
              <div style={{fontSize:36,marginBottom:8,display:'flex',justifyContent:'center'}}><Target size={36} strokeWidth={1.5} color={DS.accent.amber}/></div>
              <div style={{fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:6}}>Target grade?</div>
              <div style={{fontSize:13,color:DS.text.secondary,marginBottom:20}}>Lumora will tune difficulty to your goal</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(72px,1fr))',gap:10}}>
                {grades.map(g=>(
                  <button key={g} onClick={()=>update('grade',g)} style={{padding:'18px 0',borderRadius:DS.radius.md,border:`1.5px solid ${profile.grade===g?DS.accent.amber:DS.border}`,background:profile.grade===g?DS.accent.amberDim:DS.bg.elevated,color:profile.grade===g?DS.accent.amber:DS.text.secondary,fontWeight:900,fontSize:22,cursor:'pointer',transition:DS.tr}}>
                    {g}
                  </button>
                ))}
              </div>
            </div>
          )}
          {step===4&&(
            <div style={{animation:'fadeInUp 0.3s ease'}}>
              <div style={{fontSize:36,marginBottom:8,display:'flex',justifyContent:'center'}}><Calendar size={36} strokeWidth={1.5} color={DS.accent.amber}/></div>
              <div style={{fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:6}}>When's your exam?</div>
              <div style={{fontSize:13,color:DS.text.secondary,marginBottom:20}}>We'll create a revision countdown for you</div>
              <input type="date" value={profile.examDate} onChange={e=>update('examDate',e.target.value)} style={{width:'100%',padding:'14px 16px',borderRadius:DS.radius.md,border:`1.5px solid ${DS.border}`,fontSize:16,fontFamily:'inherit',outline:'none',boxSizing:'border-box',color:DS.text.primary,background:DS.bg.elevated,colorScheme:'dark'}} onFocus={e=>e.target.style.borderColor=DS.accent.amber} onBlur={e=>e.target.style.borderColor=DS.border}/>
              {weeks!==null&&<div style={{marginTop:12,background:DS.accent.amberDim,borderRadius:DS.radius.md,padding:'12px 16px',fontSize:13,color:DS.accent.amber,fontWeight:700,border:`1px solid ${DS.accent.amber}33`}}>📆 {weeks} week{weeks!==1?'s':''} to go — let's make every session count</div>}
            </div>
          )}
          {step===5&&(
            <div style={{animation:'fadeInUp 0.3s ease'}}>
              <div style={{fontSize:36,marginBottom:8,display:'flex',justifyContent:'center'}}><BarChart2 size={36} strokeWidth={1.5} color={DS.accent.amber}/></div>
              <div style={{fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:6}}>Your biggest weaknesses?</div>
              <div style={{fontSize:13,color:DS.text.secondary,marginBottom:16}}>Pick up to 3 topics — we'll prioritise these first</div>
              <div style={{maxHeight:280,overflowY:'auto',display:'grid',gap:6}}>
                {allTopics.map(t=>{
                  const sel=profile.weaknesses.includes(t.id);
                  const dis=!sel&&profile.weaknesses.length>=3;
                  return(
                    <button key={t.id} onClick={()=>!dis&&toggleWeak(t.id)} style={{padding:'10px 14px',borderRadius:DS.radius.sm,border:`1.5px solid ${sel?DS.accent.amber:DS.border}`,background:sel?DS.accent.amberDim:DS.bg.elevated,color:sel?DS.accent.amber:DS.text.secondary,fontWeight:sel?700:400,fontSize:12,cursor:dis?'not-allowed':'pointer',textAlign:'left',opacity:dis?0.4:1,display:'flex',justifyContent:'space-between',alignItems:'center',transition:DS.tr}}>
                      <span>{t.title}</span>{sel&&<span style={{color:DS.accent.amber,display:'flex',alignItems:'center'}}><Check size={12} strokeWidth={2.5}/></span>}
                    </button>
                  );
                })}
              </div>
              <div style={{fontSize:11,color:DS.text.muted,marginTop:8}}>{profile.weaknesses.length}/3 selected</div>
            </div>
          )}
          <button onClick={handleNext} disabled={!canNext} style={{marginTop:24,width:'100%',padding:'15px 0',borderRadius:DS.radius.md,border:'none',background:canNext?DS.accent.amber:DS.bg.overlay,color:canNext?DS.bg.base:DS.text.muted,fontWeight:900,fontSize:15,cursor:canNext?'pointer':'not-allowed',transition:DS.tr}}>
            {step<5?'Continue →':<>Let's go, {profile.name}! <Rocket size={15} strokeWidth={2} style={{display:'inline',verticalAlign:'middle'}}/></>}
          </button>
          {step>1&&<button onClick={()=>setStep(s=>s-1)} style={{marginTop:8,width:'100%',padding:'10px 0',borderRadius:DS.radius.md,border:'none',background:'transparent',color:DS.text.muted,fontSize:13,cursor:'pointer'}}>← Back</button>}
        </div>
      </div>
    </div>
  );
}

// ═══ DEMO MODE ═══════════════════════════════════════════════════════════════
const DEMO_QUESTIONS=MODULES.slice(0,5).map(m=>{
  const topic=m.topics[0];
  const q=topic.questions.find(q=>q.diff==='Starter')||topic.questions[0];
  return{...q,topicTitle:topic.title,moduleLabel:m.label,moduleColor:m.color,moduleIcon:m.icon,topicId:topic.id,ms:q.ms||topic.markScheme||[]};
});

function DemoMode({onSignUp,onBack}){
  const [idx,setIdx]=useState(0);
  const [working,setWorking]=useState('');
  const [aiResult,setAiResult]=useState(null);
  const [aiLoading,setAiLoading]=useState(false);
  const [answered,setAnswered]=useState(false);
  const [scores,setScores]=useState([]);
  const [phase,setPhase]=useState('q');

  const q=DEMO_QUESTIONS[idx];
  const progress=((idx+(answered?1:0))/DEMO_QUESTIONS.length)*100;
  const totalEarned=scores.reduce((s,x)=>s+x.earned,0);
  const totalMarks=scores.reduce((s,x)=>s+x.total,0);

  const handleAIMark=async()=>{
    if(!working.trim()||aiLoading||answered)return;
    setAiLoading(true);
    try{
      const r=await aiMark(q.q,q.marks,q.ms,working);
      setAiResult(r);
      setAnswered(true);
      setScores(prev=>[...prev,{earned:r.marksEarned,total:q.marks}]);
    }catch(e){setAiResult({error:e.message,marksEarned:0,feedback:'Could not connect to AI — check your answer against the mark scheme.'});}
    setAiLoading(false);
  };

  const handleNext=()=>{
    if(idx+1>=DEMO_QUESTIONS.length){setPhase('done');return;}
    setIdx(i=>i+1);setWorking('');setAiResult(null);setAnswered(false);
  };

  if(phase==='done'){
    const pct=totalMarks>0?Math.round((totalEarned/totalMarks)*100):0;
    const grade=GRADE_BOUNDARIES.find(b=>pct/100>=b.min)||GRADE_BOUNDARIES[GRADE_BOUNDARIES.length-1];
    return(
      <div style={{fontFamily:"'Segoe UI',sans-serif",background:DS.bg.base,minHeight:'100vh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:24}}>
        <AnimStyles/>
        <div style={{width:'100%',maxWidth:440,animation:'popIn 0.5s ease-out'}}>
          <div style={{background:DS.bg.surface,border:`2px solid ${DS.accent.amber}44`,borderRadius:DS.radius.xl,padding:32,textAlign:'center',boxShadow:DS.shadow,marginBottom:16}}>
            <div style={{fontSize:56,fontWeight:900,color:grade.color,lineHeight:1,marginBottom:4}}>{grade.grade}</div>
            <div style={{fontSize:13,color:DS.text.muted,marginBottom:20,fontWeight:600}}>Demo predicted grade · {pct}% accuracy</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,marginBottom:24}}>
              {scores.map((s,i)=>{
                const dq=DEMO_QUESTIONS[i];
                const ratio=s.earned/s.total;
                const c=ratio>=0.7?DS.accent.teal:ratio>=0.4?DS.accent.amber:DS.accent.red;
                return(
                  <div key={i} style={{background:DS.bg.elevated,borderRadius:DS.radius.md,padding:'10px 8px',border:`1px solid ${DS.border}`}}>
                    <div style={{fontSize:9,color:DS.text.muted,fontWeight:700,marginBottom:4,textTransform:'uppercase',letterSpacing:0.5,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{dq.moduleLabel}</div>
                    <div style={{fontSize:18,fontWeight:900,color:c}}>{s.earned}/{s.total}</div>
                  </div>
                );
              })}
            </div>
            <div style={{background:DS.accent.amberDim,border:`1px solid ${DS.accent.amber}44`,borderRadius:DS.radius.md,padding:'12px 16px',marginBottom:20,fontSize:13,color:DS.accent.amber,fontWeight:700}}>
              Create a free account to save your progress and get a full revision plan
            </div>
            <button onClick={onSignUp} style={{width:'100%',padding:'15px 0',borderRadius:DS.radius.md,border:'none',background:`linear-gradient(135deg,${DS.accent.amber},#E8B84B)`,color:DS.bg.base,fontWeight:900,fontSize:15,cursor:'pointer',marginBottom:10,boxShadow:`0 6px 20px ${DS.accent.amber}44`}}>
              Save my progress — it's free →
            </button>
            <button onClick={onBack} style={{width:'100%',padding:'10px 0',borderRadius:DS.radius.md,border:'none',background:'transparent',color:DS.text.muted,fontSize:12,cursor:'pointer'}}>
              Back to home
            </button>
          </div>
        </div>
      </div>
    );
  }

  return(
    <div style={{fontFamily:"'Segoe UI',sans-serif",background:DS.bg.base,minHeight:'100vh'}}>
      <AnimStyles/>
      {/* Header */}
      <div style={{background:DS.bg.surface,borderBottom:`1px solid ${DS.border}`,padding:'12px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:0,zIndex:10}}>
        <div style={{fontSize:14,fontWeight:900,color:DS.accent.amber}}>📐 Lumora</div>
        <div style={{flex:1,margin:'0 16px'}}>
          <div style={{height:4,background:DS.bg.elevated,borderRadius:2,overflow:'hidden'}}>
            <div style={{height:'100%',background:DS.accent.amber,borderRadius:2,width:`${progress}%`,transition:'width 0.4s ease'}}/>
          </div>
          <div style={{fontSize:10,color:DS.text.muted,textAlign:'center',marginTop:3,fontWeight:600}}>{idx+1} of {DEMO_QUESTIONS.length} questions</div>
        </div>
        <button onClick={onSignUp} style={{fontSize:11,fontWeight:800,color:DS.accent.amber,background:DS.accent.amberDim,border:`1px solid ${DS.accent.amber}44`,borderRadius:DS.radius.sm,padding:'6px 12px',cursor:'pointer',whiteSpace:'nowrap'}}>Sign up free</button>
      </div>

      <div style={{maxWidth:620,margin:'0 auto',padding:'20px 16px'}}>
        {/* Module badge */}
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
          <div style={{fontSize:16}}>{q.moduleIcon}</div>
          <div style={{fontSize:11,fontWeight:700,color:q.moduleColor,textTransform:'uppercase',letterSpacing:1}}>{q.moduleLabel}</div>
          <div style={{fontSize:11,color:DS.text.muted}}>· {q.topicTitle}</div>
          <div style={{marginLeft:'auto',fontSize:10,fontWeight:700,color:DIFF[q.diff]?.color||DS.text.muted,background:DS.bg.elevated,borderRadius:DS.radius.sm,padding:'2px 8px'}}>{q.diff}</div>
        </div>

        {/* Question */}
        <div style={{background:DS.bg.surface,border:`1px solid ${DS.borderHi}`,borderRadius:DS.radius.lg,padding:'20px 20px 16px',marginBottom:14}}>
          <div style={{fontSize:13,color:DS.text.secondary,marginBottom:10,fontWeight:600}}>
            [{q.marks} mark{q.marks!==1?'s':''}]
          </div>
          <div style={{fontSize:15,color:DS.text.primary,lineHeight:1.7,fontWeight:500}}>{q.q}</div>
        </div>

        {/* Working area */}
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,color:DS.text.muted,fontWeight:700,marginBottom:6,textTransform:'uppercase',letterSpacing:1}}>Your working</div>
          <textarea
            value={working}
            onChange={e=>setWorking(e.target.value)}
            disabled={answered}
            placeholder="Show all your working here — the AI marks your method, not just the answer…"
            style={{width:'100%',minHeight:110,background:DS.bg.surface,border:`1px solid ${answered?DS.border:DS.borderHi}`,borderRadius:DS.radius.md,padding:'12px 14px',color:DS.text.primary,fontSize:13,resize:'vertical',fontFamily:"'Segoe UI',sans-serif",lineHeight:1.6,boxSizing:'border-box',opacity:answered?0.7:1}}
          />
        </div>

        {/* Mark button */}
        {!answered&&(
          <button onClick={handleAIMark} disabled={!working.trim()||aiLoading} style={{width:'100%',padding:'13px 0',borderRadius:DS.radius.md,border:'none',background:working.trim()&&!aiLoading?`linear-gradient(135deg,${DS.accent.amber},#E8B84B)`:DS.bg.overlay,color:working.trim()&&!aiLoading?DS.bg.base:DS.text.muted,fontWeight:900,fontSize:14,cursor:working.trim()&&!aiLoading?'pointer':'not-allowed',display:'flex',alignItems:'center',justifyContent:'center',gap:8,marginBottom:14,transition:DS.tr}}>
            {aiLoading?<><Loader2 size={16} strokeWidth={2} style={{animation:'spin 0.8s linear infinite'}}/> Marking your answer…</>:<><Bot size={16} strokeWidth={2}/> Mark with AI</>}
          </button>
        )}

        {/* AI result */}
        {aiResult&&(
          <div style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.lg,padding:'16px 18px',marginBottom:14,animation:'popIn 0.4s ease-out'}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
              <div style={{fontSize:28,fontWeight:900,color:aiResult.error?DS.accent.red:aiResult.marksEarned>=Math.ceil(q.marks/2)?DS.accent.teal:DS.accent.amber}}>{aiResult.error?'—':`${aiResult.marksEarned}/${q.marks}`}</div>
              <div style={{flex:1}}>
                <div style={{height:6,background:DS.bg.elevated,borderRadius:3,overflow:'hidden'}}>
                  <div style={{height:'100%',borderRadius:3,background:aiResult.marksEarned>=Math.ceil(q.marks/2)?DS.accent.teal:DS.accent.amber,width:`${Math.round(((aiResult.marksEarned||0)/q.marks)*100)}%`,transition:'width 0.6s ease'}}/>
                </div>
              </div>
            </div>
            {aiResult.feedback&&<div style={{fontSize:13,color:DS.text.secondary,lineHeight:1.6,marginBottom:aiResult.improvements?.length?10:0}}>{aiResult.feedback}</div>}
            {aiResult.improvements?.length>0&&(
              <div style={{marginTop:8}}>
                <div style={{fontSize:10,fontWeight:800,color:DS.accent.amber,textTransform:'uppercase',letterSpacing:1,marginBottom:6}}>To improve</div>
                {aiResult.improvements.map((imp,i)=><div key={i} style={{fontSize:12,color:DS.text.muted,marginBottom:3,paddingLeft:12,borderLeft:`2px solid ${DS.accent.amber}55`}}>{imp}</div>)}
              </div>
            )}
          </div>
        )}

        {/* Next / sign up nudge */}
        {answered&&(
          <div>
            {idx===2&&(
              <div style={{background:DS.accent.amberDim,border:`1px solid ${DS.accent.amber}44`,borderRadius:DS.radius.md,padding:'10px 14px',marginBottom:10,fontSize:12,color:DS.accent.amber,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <span>Sign up to track your progress</span>
                <button onClick={onSignUp} style={{background:DS.accent.amber,color:DS.bg.base,border:'none',borderRadius:DS.radius.sm,padding:'4px 12px',fontSize:11,fontWeight:800,cursor:'pointer'}}>Free →</button>
              </div>
            )}
            <button onClick={handleNext} style={{width:'100%',padding:'13px 0',borderRadius:DS.radius.md,border:`1.5px solid ${DS.accent.amber}55`,background:DS.bg.surface,color:DS.accent.amber,fontWeight:900,fontSize:14,cursor:'pointer',transition:DS.tr}}>
              {idx+1>=DEMO_QUESTIONS.length?'See my results →':'Next question →'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══ LANDING PAGE ════════════════════════════════════════════════════════════
function LandingPage({onStart,onDemo}){
  const profile=lsGet('lumora_profile',null);
  const [now]=useState(Date.now);
  const weeks=profile?.examDate?Math.max(0,Math.round((new Date(profile.examDate)-now)/(1000*60*60*24*7))):null;
  const xp=getXP();
  const lvl=getLevel(xp);
  const streak=getStreakData();
  return(
    <div style={{fontFamily:"'Segoe UI',sans-serif",background:DS.bg.base,minHeight:'100vh'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'16px 24px',borderBottom:`1px solid ${DS.border}`,background:DS.bg.surface}}>
        <div style={{fontSize:18,fontWeight:900,color:DS.accent.amber,letterSpacing:1}}>📐 Lumora</div>
        <button onClick={onStart} style={{padding:'10px 24px',borderRadius:24,border:'none',background:DS.accent.amber,color:DS.bg.base,fontWeight:900,fontSize:13,cursor:'pointer'}}>
          {profile?'Continue Learning →':'Start Free'}
        </button>
      </div>
      <div style={{textAlign:'center',padding:'60px 24px 40px',maxWidth:640,margin:'0 auto'}}>
        {profile&&(
          <div style={{background:DS.accent.amberDim,border:`1.5px solid ${DS.accent.amber}44`,borderRadius:DS.radius.lg,padding:'14px 20px',marginBottom:28,display:'inline-block'}}>
            <div style={{fontSize:14,color:DS.accent.amber,fontWeight:700}}>
              Welcome back, {profile.name}! <LevelIcon name={lvl.name} size={14} color={lvl.color}/> {xp} XP · <Flame size={13} strokeWidth={2} style={{display:'inline',verticalAlign:'middle'}}/> {streak.current} day streak{weeks!==null?<> · <Calendar size={13} strokeWidth={2} style={{display:'inline',verticalAlign:'middle'}}/> {weeks}w to exam</>:''}
            </div>
          </div>
        )}
        <div style={{fontSize:48,marginBottom:16,display:'flex',justifyContent:'center'}}><GraduationCap size={48} strokeWidth={1.5} color={DS.accent.amber}/></div>
        <h1 style={{fontSize:40,fontWeight:900,color:DS.text.primary,lineHeight:1.1,margin:'0 0 16px'}}>Meet <span style={{color:DS.accent.amber}}>Lumora</span></h1>
        <p style={{fontSize:17,color:DS.text.secondary,lineHeight:1.6,margin:'0 0 32px'}}>The AI tutor that thinks like your best teacher</p>
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:12}}>
          <button onClick={onStart} style={{padding:'16px 40px',borderRadius:50,border:'none',background:`linear-gradient(135deg,${DS.accent.amber},#E8B84B)`,color:DS.bg.base,fontWeight:900,fontSize:16,cursor:'pointer',boxShadow:`0 8px 32px ${DS.accent.amber}44`}}>
            {profile?'Continue Learning →':'Start Free — No credit card needed'}
          </button>
          {!profile&&(
            <button onClick={onDemo} style={{padding:'11px 28px',borderRadius:50,border:`1.5px solid ${DS.border}`,background:'transparent',color:DS.text.secondary,fontWeight:700,fontSize:14,cursor:'pointer',transition:DS.tr}}>
              Try a question first — no signup →
            </button>
          )}
        </div>
      </div>
      <div style={{background:DS.bg.surface,padding:'40px 24px'}}>
        <div style={{maxWidth:680,margin:'0 auto'}}>
          <div style={{textAlign:'center',fontSize:12,fontWeight:800,color:DS.accent.amber,letterSpacing:2,textTransform:'uppercase',marginBottom:24}}>The Problem With Traditional Revision</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:14,textAlign:'center'}}>
            {[{stat:'1 in 3',desc:'students underperform in GCSE Maths despite revising'},{stat:'£60/hr',desc:'average private tutor — unaffordable for most families'},{stat:'957K',desc:'young people NEET — often held back by basic Maths'}].map(s=>(
              <div key={s.stat} style={{background:DS.bg.elevated,borderRadius:DS.radius.lg,padding:'20px 12px',border:`1px solid ${DS.border}`}}>
                <div style={{fontSize:28,fontWeight:900,color:DS.accent.amber,marginBottom:8}}>{s.stat}</div>
                <div style={{fontSize:11,color:DS.text.secondary,lineHeight:1.5}}>{s.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div style={{padding:'48px 24px',maxWidth:640,margin:'0 auto'}}>
        <div style={{textAlign:'center',fontSize:12,fontWeight:800,color:DS.accent.amber,letterSpacing:2,textTransform:'uppercase',marginBottom:8}}>How It Works</div>
        <div style={{textAlign:'center',fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:28}}>Four steps from confused to confident</div>
        <div style={{display:'grid',gap:14}}>
          {[{n:1,icon:<FileText size={20} strokeWidth={2}/>,t:'Practice',d:'Work through exam-style questions at 3 difficulty levels across all GCSE Maths topics'},{n:2,icon:<Bot size={20} strokeWidth={2}/>,t:'AI Marks Your Working',d:'Claude analyses your method step-by-step, just like a real examiner would'},{n:3,icon:<BarChart2 size={20} strokeWidth={2}/>,t:'Progress Tracked',d:'Spaced repetition schedules your revision. Heatmaps show exactly where to focus next'},{n:4,icon:<Trophy size={20} strokeWidth={2}/>,t:'Level Up',d:'Earn XP, build streaks, and unlock levels as you improve. Revision that actually feels rewarding'}].map(s=>(
            <div key={s.n} style={{display:'flex',gap:16,alignItems:'flex-start',background:DS.bg.surface,borderRadius:DS.radius.lg,padding:'18px 20px',border:`1px solid ${DS.border}`}}>
              <div style={{width:40,height:40,borderRadius:DS.radius.sm,background:DS.accent.amberDim,border:`1px solid ${DS.accent.amber}44`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>{s.icon}</div>
              <div><div style={{fontSize:15,fontWeight:800,color:DS.text.primary,marginBottom:4}}>{s.t}</div><div style={{fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{s.d}</div></div>
            </div>
          ))}
        </div>
      </div>
      <div style={{background:DS.bg.surface,padding:'48px 24px'}}>
        <div style={{maxWidth:680,margin:'0 auto'}}>
          <div style={{textAlign:'center',fontSize:12,fontWeight:800,color:DS.accent.amber,letterSpacing:2,textTransform:'uppercase',marginBottom:8}}>Pricing</div>
          <div style={{textAlign:'center',fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:28}}>Simple, fair pricing</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:14}}>
            {[
              {name:'Free',price:'£0',period:' forever',features:['All topics & questions','AI marking (5/day)','Spaced repetition','Streak tracking'],cta:'Start Free',hi:false,soon:false},
              {name:'Student Plus',price:'£7.99',period:'/mo',features:['Unlimited AI marking','Socratic tutoring','Progress reports','XP & level system'],cta:'Free during beta',hi:true,soon:false},
              {name:'Tutor Connect',price:'£12.99',period:'/mo',features:['Everything in Plus','Parent dashboard','Tutor assignment','Weekly reports'],cta:'Join Waitlist',hi:false,soon:true}
            ].map(p=>(
              <div key={p.name} style={{background:p.hi?DS.accent.amber:DS.bg.elevated,borderRadius:DS.radius.lg,padding:'22px 16px',border:p.hi?'none':p.soon?`1px solid ${DS.accent.teal}44`:`1px solid ${DS.border}`,position:'relative',opacity:p.soon?0.9:1}}>
                {p.hi&&<div style={{position:'absolute',top:-10,left:'50%',transform:'translateX(-50%)',background:DS.bg.elevated,color:DS.accent.amber,fontSize:8,fontWeight:800,padding:'3px 10px',borderRadius:6,letterSpacing:1,whiteSpace:'nowrap',border:`1px solid ${DS.accent.amber}44`}}>MOST POPULAR</div>}
                {p.soon&&<div style={{position:'absolute',top:-10,left:'50%',transform:'translateX(-50%)',background:DS.accent.teal,color:DS.bg.base,fontSize:8,fontWeight:800,padding:'3px 10px',borderRadius:6,letterSpacing:1,whiteSpace:'nowrap'}}>COMING SOON</div>}
                <div style={{fontSize:14,fontWeight:800,color:p.hi?DS.bg.base:DS.text.primary,marginBottom:4}}>{p.name}</div>
                <div style={{fontSize:28,fontWeight:900,color:p.hi?DS.bg.base:p.soon?DS.accent.teal:DS.accent.amber,marginBottom:2}}>{p.price}<span style={{fontSize:11,fontWeight:500}}>{p.period}</span></div>
                <div style={{margin:'14px 0',borderTop:`1px solid ${p.hi?'rgba(0,0,0,0.15)':DS.border}`,paddingTop:14}}>
                  {p.features.map(f=><div key={f} style={{fontSize:10,color:p.hi?DS.bg.base:p.soon?DS.text.muted:DS.text.secondary,marginBottom:5,display:'flex',gap:5,alignItems:'center'}}><Check size={11} strokeWidth={2.5} style={{flexShrink:0,color:p.soon?DS.accent.teal:undefined}}/>{f}</div>)}
                </div>
                <button onClick={p.soon?(()=>{const done=localStorage.getItem('lumora_waitlist');localStorage.setItem('lumora_waitlist','1');alert(done?'You\'re already on the waitlist — we\'ll be in touch!':'You\'re on the list! We\'ll email you when Tutor Connect launches.');}):(onStart)} style={{width:'100%',padding:'9px 0',borderRadius:DS.radius.sm,border:p.soon?`1px solid ${DS.accent.teal}44`:'none',background:p.hi?DS.bg.base:p.soon?'transparent':DS.bg.overlay,color:p.hi?DS.accent.amber:p.soon?DS.accent.teal:DS.text.secondary,fontWeight:800,fontSize:11,cursor:'pointer'}}>{p.cta}</button>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div style={{textAlign:'center',padding:'28px 24px',borderTop:`1px solid ${DS.border}`}}>
        <div style={{fontSize:16,fontWeight:900,color:DS.accent.amber,marginBottom:4}}>📐 Lumora</div>
        <div style={{fontSize:11,color:DS.text.muted}}>Built to close the attainment gap · GCSE Maths · AQA · Edexcel · OCR</div>
      </div>
    </div>
  );
}

// ═══ DAILY CHALLENGE MODAL ════════════════════════════════════════════════════
function DailyChallengeModal({onComplete,onSkip,onAwardXP}){
  const [phase,setPhase]=useState('loading'); // loading|q|done
  const [questions,setQuestions]=useState([]);
  const [qIdx,setQIdx]=useState(0);
  const [working,setWorking]=useState('');
  const [msOpen,setMsOpen]=useState(false);
  const [selfMark,setSelfMark]=useState(null);
  const [aiResult,setAiResult]=useState(null);
  const [aiLoading,setAiLoading]=useState(false);
  const [qAnswers,setQAnswers]=useState({}); // {idx:{xp,mark,total,correct}}
  const [showSkip,setShowSkip]=useState(false);
  const [streakInfo,setStreakInfo]=useState(null);
  const [finalXP,setFinalXP]=useState(0);
  const hasKey=!!import.meta.env.VITE_ANTHROPIC_API_KEY;
  const streak=getStreakData();
  const profile=lsGet('lumora_profile',null);

  useEffect(()=>{
    generateDailyQs(getWeakTopics())
      .then(data=>{
        setQuestions(data?.questions?.length>=3?data.questions.slice(0,3):getFallbackDailyQs());
        setPhase('q');
      })
      .catch(()=>{setQuestions(getFallbackDailyQs());setPhase('q');});
  },[]);

  const q=questions[qIdx];
  const qAnswered=qAnswers[qIdx]!==undefined;

  const recordAnswer=(idx,mark,total)=>{
    const correct=mark>=Math.ceil(total/2);
    const xp=correct?35:10;
    setQAnswers(prev=>({...prev,[idx]:{xp,mark,total,correct}}));
  };

  const handleAIMark=async()=>{
    if(!working.trim()||aiLoading||qAnswered)return;
    setAiLoading(true);
    try{
      const r=await aiMark(q.q,q.marks,q.ms,working);
      setAiResult(r);
      recordAnswer(qIdx,r.marksEarned,q.marks);
    }catch(e){setAiResult({error:e.message});}
    setAiLoading(false);
  };

  const handleSelfMark=(mark)=>{
    if(qAnswered)return;
    setSelfMark(mark);
    recordAnswer(qIdx,mark,q.marks);
  };

  const handleNext=()=>{
    const next=qIdx+1;
    if(next<questions.length){
      setQIdx(next);setWorking('');setMsOpen(false);setSelfMark(null);setAiResult(null);
    }else{
      const allXP=Object.values({...qAnswers}).reduce((s,a)=>s+a.xp,0)+50;
      const sr=touchStreak();
      incrementWeekly();
      setDailyDone(allXP);
      setStreakInfo(sr);
      setFinalXP(allXP);
      onAwardXP(allXP,sr);
      setPhase('done');
    }
  };

  if(phase==='loading')return(
    <div style={{position:'fixed',inset:0,zIndex:1000,background:DS.bg.deep,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:"'Segoe UI',sans-serif"}}>
      <div style={{textAlign:'center'}}>
        <div style={{fontSize:52,marginBottom:16,display:'flex',justifyContent:'center'}}><Calendar size={52} strokeWidth={1.5} color={DS.accent.amber}/></div>
        <div style={{fontSize:20,fontWeight:900,color:DS.text.primary,marginBottom:6}}>Daily Challenge</div>
        <div style={{fontSize:13,color:DS.text.muted,marginBottom:24}}>Preparing today's questions…</div>
        <Loader2 size={36} strokeWidth={2} style={{animation:'spin 0.8s linear infinite',color:DS.accent.amber,margin:'0 auto',display:'block'}}/>
      </div>
    </div>
  );

  if(phase==='done'){
    const correct=Object.values(qAnswers).filter(a=>a.correct).length;
    const msgs=['"Every session builds the habit. See you tomorrow!"','"Great work — keep this momentum going!"','"Perfect score! You\'re exam-ready. 🔥"'];
    return(
      <div style={{position:'fixed',inset:0,zIndex:1000,background:DS.bg.deep,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:"'Segoe UI',sans-serif",padding:20}}>
        <div style={{width:'100%',maxWidth:420,background:DS.bg.surface,borderRadius:DS.radius.xl,padding:32,textAlign:'center',border:`1px solid ${DS.borderHi}`,boxShadow:DS.shadow,animation:'popIn 0.5s ease-out'}}>
          <div style={{fontSize:56,marginBottom:12}}>🎉</div>
          <div style={{fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:4}}>Challenge Complete!</div>
          <div style={{fontSize:13,color:DS.text.secondary,marginBottom:24}}>{correct}/{questions.length} correct today</div>
          <div style={{display:'flex',gap:12,justifyContent:'center',marginBottom:24}}>
            <div style={{background:DS.accent.amberDim,border:`1px solid ${DS.accent.amber}33`,borderRadius:DS.radius.md,padding:'12px 20px'}}>
              <div style={{fontSize:26,fontWeight:900,color:DS.accent.amber}}>+{finalXP}</div>
              <div style={{fontSize:10,color:DS.text.muted,fontWeight:700,textTransform:'uppercase',letterSpacing:1}}>XP Earned</div>
            </div>
            <div style={{background:DS.accent.redDim,border:`1px solid rgba(255,76,76,0.2)`,borderRadius:DS.radius.md,padding:'12px 20px'}}>
              <div style={{fontSize:26,fontWeight:900,color:DS.accent.red,display:'flex',alignItems:'center',gap:4}}><Flame size={20} strokeWidth={2}/> {streakInfo?.streak||streak.current}</div>
              <div style={{fontSize:10,color:DS.text.muted,fontWeight:700,textTransform:'uppercase',letterSpacing:1}}>Day Streak</div>
            </div>
          </div>
          {streakInfo?.milestone&&<div style={{background:DS.accent.tealDim,border:`1px solid ${DS.accent.teal}33`,borderRadius:DS.radius.md,padding:'10px 14px',marginBottom:16,fontSize:13,color:DS.accent.teal,fontWeight:700}}>🏅 Streak freeze earned! ❄️</div>}
          <div style={{fontSize:13,color:DS.text.secondary,marginBottom:24,lineHeight:1.6,fontStyle:'italic'}}>{msgs[Math.min(correct,2)]}</div>
          <button onClick={onComplete} style={{width:'100%',padding:'14px 0',borderRadius:DS.radius.md,border:'none',background:DS.accent.amber,color:DS.bg.base,fontWeight:900,fontSize:15,cursor:'pointer',transition:DS.tr}}>
            Continue to Lumora →
          </button>
        </div>
      </div>
    );
  }

  if(showSkip)return(
    <div style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,0.88)',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:"'Segoe UI',sans-serif",padding:20}}>
      <div style={{width:'100%',maxWidth:360,background:DS.bg.surface,borderRadius:DS.radius.xl,padding:28,textAlign:'center',border:`1px solid ${DS.border}`,boxShadow:DS.shadow}}>
        <div style={{fontSize:40,marginBottom:12,display:'flex',justifyContent:'center'}}><AlertTriangle size={40} strokeWidth={1.5} color={DS.accent.amber}/></div>
        <div style={{fontSize:18,fontWeight:900,color:DS.text.primary,marginBottom:8}}>Skip today?</div>
        <div style={{fontSize:13,color:DS.accent.red,fontWeight:700,marginBottom:20,background:DS.accent.redDim,borderRadius:DS.radius.sm,padding:'8px 12px',border:`1px solid ${DS.accent.red}33`}}>
          {streak.current>0?`Skipping resets your ${streak.current}-day streak!`:'Skipping breaks your streak habit.'}
        </div>
        <div style={{display:'flex',gap:10}}>
          <button onClick={()=>setShowSkip(false)} style={{flex:1,padding:'12px 0',borderRadius:DS.radius.md,border:`1.5px solid ${DS.border}`,background:'transparent',color:DS.text.secondary,fontWeight:700,fontSize:13,cursor:'pointer'}}>Keep Going</button>
          <button onClick={onSkip} style={{flex:1,padding:'12px 0',borderRadius:DS.radius.md,border:'none',background:DS.accent.red,color:'#fff',fontWeight:800,fontSize:13,cursor:'pointer'}}>Skip Anyway</button>
        </div>
      </div>
    </div>
  );

  if(!q)return null;
  const d=DIFF[q.diff]||DIFF.Starter;
  return(
    <div style={{position:'fixed',inset:0,zIndex:1000,background:DS.bg.deep,overflowY:'auto',fontFamily:"'Segoe UI',sans-serif"}}>
      {/* Header */}
      <div style={{background:DS.bg.surface,padding:'12px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:`1px solid ${DS.border}`,position:'sticky',top:0,zIndex:10}}>
        <div>
          <div style={{fontSize:11,fontWeight:800,color:DS.accent.amber,letterSpacing:1.5,textTransform:'uppercase'}}>Daily Challenge</div>
          <div style={{fontSize:10,color:DS.text.muted,marginTop:1,display:'flex',alignItems:'center',gap:3}}><Flame size={11} strokeWidth={2} color={DS.accent.red}/> {streak.current} day streak{profile?` · ${profile.name}`:''}</div>
        </div>
        <div style={{display:'flex',gap:6,alignItems:'center'}}>
          {questions.map((_,i)=>(
            <div key={i} style={{width:i===qIdx?20:8,height:8,borderRadius:4,background:qAnswers[i]!==undefined?DS.accent.teal:i===qIdx?DS.accent.amber:DS.bg.overlay,transition:'all 0.3s ease'}}/>
          ))}
        </div>
        <button onClick={()=>setShowSkip(true)} style={{background:'none',border:`1px solid ${DS.border}`,color:DS.text.muted,fontSize:11,cursor:'pointer',fontWeight:600,padding:'4px 10px',borderRadius:DS.radius.sm}}>Skip</button>
      </div>

      {/* Question */}
      <div style={{maxWidth:600,margin:'0 auto',padding:'20px 16px'}}>
        <div style={{background:DS.bg.surface,borderRadius:DS.radius.lg,border:`1.5px solid ${DS.border}`,overflow:'hidden',animation:'slideUp 0.3s ease'}}>
          <div style={{padding:'16px 20px',borderBottom:`1px solid ${DS.border}`}}>
            <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:10}}>
              <span style={{background:d.bg,color:d.c,fontSize:11,fontWeight:800,padding:'2px 8px',borderRadius:6}}>{q.diff}</span>
              <span style={{fontSize:11,color:DS.text.muted}}>[{q.marks} mark{q.marks>1?'s':''}]</span>
              <span style={{marginLeft:'auto',fontSize:11,fontWeight:700,color:DS.text.secondary}}>Q{qIdx+1} of {questions.length}</span>
            </div>
            <p style={{margin:0,fontSize:15,lineHeight:1.7,color:DS.text.primary}}>{q.q}</p>
          </div>

          <div style={{padding:'14px 20px',borderBottom:`1px solid ${DS.border}`}}>
            <div style={{fontSize:11,fontWeight:700,color:DS.text.secondary,marginBottom:6}}>Your working:</div>
            <textarea value={working} onChange={e=>setWorking(e.target.value)} placeholder="Write your working here…" disabled={qAnswered}
              style={{width:'100%',minHeight:80,padding:10,borderRadius:DS.radius.sm,border:`1.5px solid ${DS.border}`,fontSize:13,fontFamily:'inherit',resize:'vertical',boxSizing:'border-box',outline:'none',background:qAnswered?DS.bg.overlay:DS.bg.elevated,color:DS.text.primary,opacity:qAnswered?0.7:1}}
              onFocus={e=>e.target.style.borderColor=DS.accent.amber} onBlur={e=>e.target.style.borderColor=DS.border}/>
          </div>

          <div style={{padding:'12px 20px',display:'flex',flexDirection:'column',gap:8}}>
            {/* Mark scheme toggle */}
            <button onClick={()=>setMsOpen(!msOpen)} style={{width:'100%',padding:'9px 0',borderRadius:DS.radius.sm,border:`1.5px solid ${msOpen?DS.accent.teal:DS.border}`,background:msOpen?DS.accent.tealDim:'transparent',color:msOpen?DS.accent.teal:DS.text.secondary,fontSize:11,fontWeight:700,cursor:'pointer',transition:DS.tr}}>
              {msOpen?'Hide Mark Scheme':'Show Mark Scheme'}
            </button>
            {msOpen&&(
              <div style={{background:DS.bg.elevated,borderRadius:DS.radius.sm,padding:'12px 14px'}}>
                <div style={{fontSize:9,fontWeight:800,color:DS.accent.teal,textTransform:'uppercase',letterSpacing:1,marginBottom:6}}>Mark Scheme</div>
                {q.ms.map((m,i)=><div key={i} style={{fontSize:13,color:DS.text.primary,padding:'3px 0',display:'flex',gap:8}}><span style={{color:DS.accent.teal,fontWeight:700}}>›</span>{m}</div>)}
                {q.insight&&<div style={{background:DS.bg.surface,borderLeft:`3px solid ${DS.accent.teal}`,borderRadius:`0 6px 6px 0`,padding:'8px 12px',marginTop:8}}><p style={{margin:0,fontSize:12,color:DS.text.secondary,lineHeight:1.5,display:'flex',gap:5,alignItems:'flex-start'}}><Lightbulb size={13} strokeWidth={2} style={{flexShrink:0,marginTop:2}}/>{q.insight}</p></div>}
                <div style={{marginTop:12}}>
                  <div style={{fontSize:11,fontWeight:700,color:DS.text.secondary,marginBottom:6}}>Self-mark:</div>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                    {Array.from({length:q.marks+1},(_,i)=>i).map(m=>(
                      <button key={m} onClick={()=>handleSelfMark(m)} disabled={qAnswered&&selfMark!==m}
                        style={{padding:'7px 12px',borderRadius:DS.radius.sm,border:`1.5px solid ${selfMark===m&&qAnswers[qIdx]?.mark===m?DS.accent.amber:DS.border}`,background:selfMark===m&&qAnswers[qIdx]?.mark===m?DS.accent.amberDim:DS.bg.surface,color:selfMark===m&&qAnswers[qIdx]?.mark===m?DS.accent.amber:DS.text.secondary,fontWeight:800,fontSize:13,cursor:qAnswered&&selfMark!==m?'not-allowed':'pointer',transition:DS.tr}}>
                        {m}/{q.marks}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* AI marking */}
            {hasKey&&working.trim()&&(
              <button onClick={handleAIMark} disabled={aiLoading||qAnswered}
                style={{width:'100%',padding:'9px 0',borderRadius:DS.radius.sm,border:`1.5px solid ${DS.borderHi}`,background:aiLoading||qAnswered?DS.bg.overlay:DS.bg.surface,color:aiLoading||qAnswered?DS.text.muted:DS.accent.amber,fontWeight:800,fontSize:12,cursor:aiLoading||qAnswered?'not-allowed':'pointer',transition:DS.tr}}>
                {aiLoading?'Marking…':'Get AI Feedback'}
              </button>
            )}
            {aiResult&&!aiResult.error&&(
              <div style={{background:DS.bg.elevated,border:`1.5px solid ${DS.borderHi}`,borderRadius:DS.radius.md,padding:12,animation:'slideUp 0.25s ease'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                  <div style={{fontSize:12,fontWeight:800,color:DS.text.primary}}>AI Feedback</div>
                  <div style={{width:38,height:38,borderRadius:'50%',background:aiResult.marksEarned===q.marks?DS.accent.tealDim:aiResult.marksEarned>0?DS.accent.amberDim:DS.accent.redDim,border:`2px solid ${aiResult.marksEarned===q.marks?DS.accent.teal:aiResult.marksEarned>0?DS.accent.amber:DS.accent.red}`,display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <span style={{fontSize:11,fontWeight:900,color:aiResult.marksEarned===q.marks?DS.accent.teal:aiResult.marksEarned>0?DS.accent.amber:DS.accent.red}}>{aiResult.marksEarned}/{q.marks}</span>
                  </div>
                </div>
                {aiResult.feedback&&<div style={{borderLeft:`3px solid ${DS.accent.teal}`,paddingLeft:10,marginBottom:6}}><p style={{margin:0,fontSize:12,color:DS.text.secondary,lineHeight:1.5}}>{aiResult.feedback}</p></div>}
                {aiResult.improvements&&<div style={{borderLeft:`3px solid ${DS.accent.amber}`,paddingLeft:10}}><p style={{margin:0,fontSize:12,color:DS.text.secondary,lineHeight:1.5}}>{aiResult.improvements}</p></div>}
              </div>
            )}
            {aiResult?.error&&<div style={{background:DS.accent.redDim,borderRadius:DS.radius.sm,padding:'8px 12px',color:DS.accent.red,fontSize:12}}>{aiResult.error}</div>}

            {/* Next / Finish */}
            <button onClick={handleNext} disabled={!qAnswered}
              style={{width:'100%',padding:'13px 0',borderRadius:DS.radius.md,border:'none',background:qAnswered?DS.accent.amber:DS.bg.overlay,color:qAnswered?DS.bg.base:DS.text.muted,fontWeight:900,fontSize:14,cursor:qAnswered?'pointer':'not-allowed',transition:DS.tr,marginTop:4}}>
              {qIdx<questions.length-1?'Next Question →':'Finish Challenge 🎉'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══ AUTH SCREENS ════════════════════════════════════════════════════════════
function LoginScreen({onLogin,onRegister}){
  const [email,setEmail]=useState('');
  const [pw,setPw]=useState('');
  const [err,setErr]=useState('');
  const [loading,setLoading]=useState(false);

  const handleLogin=async(e)=>{
    e.preventDefault();setErr('');setLoading(true);
    try{
      const user=await sbSignIn(email.trim().toLowerCase(),pw);
      initCurrentUser(user.email,user.id);
      await loadProgressFromSupabase(user.id);
      identify(user.email);
      track('user_signed_in');
      onLogin();
    }catch(err){setErr(err.message||'Something went wrong. Try again.');}
    finally{setLoading(false);}
  };

  return(
    <div style={{minHeight:'100vh',background:DS.bg.base,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:24,fontFamily:"'Segoe UI',sans-serif"}}>
      <AnimStyles/>
      <div style={{width:'100%',maxWidth:400}}>
        <div style={{marginBottom:32,textAlign:'center'}}>
          <div style={{fontSize:28,fontWeight:900,color:DS.accent.amber,letterSpacing:0.5,marginBottom:6}}>📐 Lumora</div>
          <div style={{color:DS.text.secondary,fontSize:15}}>Welcome back — sign in to continue</div>
        </div>
        <form onSubmit={handleLogin} style={{background:DS.bg.surface,borderRadius:DS.radius.xl,padding:28,border:`1px solid ${DS.border}`,boxShadow:DS.shadow,display:'flex',flexDirection:'column',gap:14}}>
          <div>
            <label style={{fontSize:12,color:DS.text.secondary,display:'block',marginBottom:4}}>Email</label>
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)} required
              placeholder="you@email.com"
              style={{width:'100%',boxSizing:'border-box',background:DS.bg.elevated,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:'10px 12px',color:DS.text.primary,fontSize:14,outline:'none'}}
            />
          </div>
          <div>
            <label style={{fontSize:12,color:DS.text.secondary,display:'block',marginBottom:4}}>Password</label>
            <input type="password" value={pw} onChange={e=>setPw(e.target.value)} required
              placeholder="••••••••"
              style={{width:'100%',boxSizing:'border-box',background:DS.bg.elevated,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:'10px 12px',color:DS.text.primary,fontSize:14,outline:'none'}}
            />
          </div>
          {err&&<div style={{color:DS.accent.red,fontSize:13,background:DS.accent.redDim,borderRadius:DS.radius.sm,padding:'8px 12px'}}>{err}</div>}
          <button type="submit" disabled={loading} style={{background:DS.accent.amber,color:'#000',border:'none',borderRadius:DS.radius.md,padding:'11px',fontWeight:800,fontSize:14,cursor:loading?'not-allowed':'pointer',opacity:loading?0.7:1,marginTop:4}}>
            {loading?'Signing in…':'Sign In'}
          </button>
          <div style={{textAlign:'center',fontSize:13,color:DS.text.muted,marginTop:4}}>
            New student?{' '}
            <button type="button" onClick={onRegister} style={{background:'none',border:'none',color:DS.accent.teal,fontWeight:700,cursor:'pointer',fontSize:13}}>Create account</button>
          </div>
        </form>
        <div style={{textAlign:'center',marginTop:20,fontSize:11,color:DS.text.muted}}>🔒 Data stored on this device only</div>
      </div>
    </div>
  );
}

function AccountCreateScreen({onCreated}){
  const [email,setEmail]=useState('');
  const [pw,setPw]=useState('');
  const [pw2,setPw2]=useState('');
  const [err,setErr]=useState('');
  const [loading,setLoading]=useState(false);

  const handleCreate=async(e)=>{
    e.preventDefault();setErr('');
    if(pw.length<6){setErr('Password must be at least 6 characters.');return;}
    if(pw!==pw2){setErr('Passwords do not match.');return;}
    setLoading(true);
    try{
      const profile=lsGet('lumora_profile',{});
      const key=email.trim().toLowerCase();
      const user=await sbSignUp(key,pw,profile);
      initCurrentUser(key,user?.id);
      if(user?.id)await loadProgressFromSupabase(user.id);
      identify(key,{name:profile.name,board:profile.board,grade:profile.grade});
      track('account_created',{board:profile.board,grade:profile.grade});
      onCreated();
    }catch(err){setErr(err.message||'Something went wrong. Try again.');}
    finally{setLoading(false);}
  };

  return(
    <div style={{minHeight:'100vh',background:DS.bg.base,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:24,fontFamily:"'Segoe UI',sans-serif"}}>
      <AnimStyles/>
      <div style={{width:'100%',maxWidth:400}}>
        <div style={{marginBottom:32,textAlign:'center'}}>
          <div style={{fontSize:28,fontWeight:900,color:DS.accent.amber,letterSpacing:0.5,marginBottom:6}}>📐 Lumora</div>
          <div style={{color:DS.text.secondary,fontSize:15}}>Create your account to save progress</div>
        </div>
        <form onSubmit={handleCreate} style={{background:DS.bg.surface,borderRadius:DS.radius.xl,padding:28,border:`1px solid ${DS.border}`,boxShadow:DS.shadow,display:'flex',flexDirection:'column',gap:14}}>
          <div>
            <label style={{fontSize:12,color:DS.text.secondary,display:'block',marginBottom:4}}>Email</label>
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)} required
              placeholder="you@email.com"
              style={{width:'100%',boxSizing:'border-box',background:DS.bg.elevated,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:'10px 12px',color:DS.text.primary,fontSize:14,outline:'none'}}
            />
          </div>
          <div>
            <label style={{fontSize:12,color:DS.text.secondary,display:'block',marginBottom:4}}>Password</label>
            <input type="password" value={pw} onChange={e=>setPw(e.target.value)} required
              placeholder="Min. 6 characters"
              style={{width:'100%',boxSizing:'border-box',background:DS.bg.elevated,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:'10px 12px',color:DS.text.primary,fontSize:14,outline:'none'}}
            />
          </div>
          <div>
            <label style={{fontSize:12,color:DS.text.secondary,display:'block',marginBottom:4}}>Confirm Password</label>
            <input type="password" value={pw2} onChange={e=>setPw2(e.target.value)} required
              placeholder="••••••••"
              style={{width:'100%',boxSizing:'border-box',background:DS.bg.elevated,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:'10px 12px',color:DS.text.primary,fontSize:14,outline:'none'}}
            />
          </div>
          {err&&<div style={{color:DS.accent.red,fontSize:13,background:DS.accent.redDim,borderRadius:DS.radius.sm,padding:'8px 12px'}}>{err}</div>}
          <button type="submit" disabled={loading} style={{background:DS.accent.amber,color:'#000',border:'none',borderRadius:DS.radius.md,padding:'11px',fontWeight:800,fontSize:14,cursor:loading?'not-allowed':'pointer',opacity:loading?0.7:1,marginTop:4}}>
            {loading?'Creating…':'Create Account'}
          </button>
        </form>
        <div style={{textAlign:'center',marginTop:20,fontSize:11,color:DS.text.muted}}>🔒 Data stored on this device only</div>
      </div>
    </div>
  );
}

function SettingsPanel({onClose,onLogout}){
  const profile=lsGet('lumora_profile',{});
  const email=getCurrentUserEmail()||'';
  const [showLogoutConfirm,setShowLogoutConfirm]=useState(false);
  const isMobile=useIsMobile();

  return(
    <div style={{position:'fixed',inset:0,zIndex:200,display:'flex',alignItems:'flex-start',justifyContent:'flex-end'}}>
      <div onClick={onClose} style={{position:'absolute',inset:0,background:'rgba(0,0,0,0.55)'}}/>
      <div style={{position:'relative',width:isMobile?'100%':320,height:'100%',background:DS.bg.surface,borderLeft:`1px solid ${DS.border}`,padding:'24px 20px',display:'flex',flexDirection:'column',gap:20,overflowY:'auto',boxShadow:DS.shadow}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div style={{fontSize:16,fontWeight:800,color:DS.text.primary}}>Account</div>
          <button onClick={onClose} style={{background:'none',border:'none',color:DS.text.muted,fontSize:20,cursor:'pointer',lineHeight:1}}>×</button>
        </div>

        <div style={{background:DS.bg.elevated,borderRadius:DS.radius.lg,padding:16,border:`1px solid ${DS.border}`}}>
          <div style={{fontSize:18,fontWeight:800,color:DS.text.primary,marginBottom:2}}>{profile.name||'Student'}</div>
          <div style={{fontSize:13,color:DS.text.secondary,marginBottom:8}}>{email}</div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            {profile.board&&<span style={{fontSize:11,background:DS.accent.amberDim,color:DS.accent.amber,borderRadius:DS.radius.sm,padding:'2px 8px',fontWeight:700}}>{profile.board}</span>}
            {profile.grade&&<span style={{fontSize:11,background:DS.accent.tealDim,color:DS.accent.teal,borderRadius:DS.radius.sm,padding:'2px 8px',fontWeight:700}}>Target: Grade {profile.grade}</span>}
          </div>
        </div>

        <div>
          <div style={{fontSize:11,color:DS.text.muted,marginBottom:8,textTransform:'uppercase',letterSpacing:0.5}}>Study Stats</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
            {[
              {label:'Total XP',value:`${getXP()} XP`},
              {label:'Current Streak',value:`${getStreakData().current} days`},
              {label:'Best Streak',value:`${getStreakData().best} days`},
              {label:'Account Created',value:profile.createdAt?new Date(profile.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'short'}):'—'},
            ].map(s=>(
              <div key={s.label} style={{background:DS.bg.elevated,borderRadius:DS.radius.md,padding:'10px 12px',border:`1px solid ${DS.border}`}}>
                <div style={{fontSize:11,color:DS.text.muted,marginBottom:2}}>{s.label}</div>
                <div style={{fontSize:14,fontWeight:800,color:DS.text.primary}}>{s.value}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{marginTop:'auto'}}>
          {showLogoutConfirm?(
            <div style={{background:DS.accent.redDim,border:`1px solid rgba(255,76,76,0.3)`,borderRadius:DS.radius.lg,padding:14}}>
              <div style={{fontSize:13,color:DS.text.primary,marginBottom:10}}>Sign out of <strong>{email}</strong>? Your data stays on this device.</div>
              <div style={{display:'flex',gap:8}}>
                <button onClick={onLogout} style={{flex:1,background:DS.accent.red,color:'#fff',border:'none',borderRadius:DS.radius.md,padding:'8px',fontWeight:700,fontSize:13,cursor:'pointer'}}>Sign Out</button>
                <button onClick={()=>setShowLogoutConfirm(false)} style={{flex:1,background:DS.bg.elevated,color:DS.text.secondary,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:'8px',fontWeight:700,fontSize:13,cursor:'pointer'}}>Cancel</button>
              </div>
            </div>
          ):(
            <button onClick={()=>setShowLogoutConfirm(true)} style={{width:'100%',background:'transparent',border:`1px solid rgba(255,76,76,0.3)`,borderRadius:DS.radius.md,padding:'10px',color:DS.accent.red,fontWeight:700,fontSize:13,cursor:'pointer'}}>Sign Out</button>
          )}
          <button onClick={()=>{const code=encodeProgress();const url=`${window.location.origin}${window.location.pathname}?p=${code}`;navigator.clipboard.writeText(url).then(()=>alert('Progress link copied!\n\nShare it with parents, tutors, or anyone to show your GCSE Maths progress.')).catch(()=>prompt('Copy this link to share your progress:',url));}} style={{width:'100%',background:'transparent',border:`1px solid ${DS.accent.teal}44`,borderRadius:DS.radius.md,padding:'10px',color:DS.accent.teal,fontWeight:700,fontSize:13,cursor:'pointer',marginTop:8,display:'flex',alignItems:'center',justifyContent:'center',gap:6}}><Share2 size={14} strokeWidth={2}/>Share Progress Report</button>
          <div style={{textAlign:'center',marginTop:14,fontSize:11,color:DS.text.muted}}>🔒 Data stored on this device only</div>
        </div>
      </div>
    </div>
  );
}

// ═══ SHARE PROGRESS ══════════════════════════════════════════════════════════
function encodeProgress(){
  const perf=lsGet('gcse_perf',{});
  const profile=lsGet('lumora_profile',{});
  const xp=getXP();
  const streak=getStreakData();
  const entries=Object.entries(perf).filter(([,p])=>p.total>0);
  const avg=entries.length?Math.round(entries.reduce((s,[,p])=>s+(p.correct/p.total),0)/entries.length*100):0;
  const data={n:profile.name||'A student',xp,streak:streak.current,best:streak.best,topics:entries.length,qs:entries.reduce((s,[,p])=>s+p.total,0),avg,ts:Date.now()};
  return btoa(encodeURIComponent(JSON.stringify(data)));
}
function ProgressReport({data}){
  const {n,xp,streak,best,topics,qs,avg,ts}=data;
  const date=new Date(ts).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  const gradeBnd=calcGrade(avg/100);
  const grade=gradeBnd.grade;
  const gradeColor=gradeBnd.color;
  return(
    <div style={{minHeight:'100vh',background:DS.bg.base,fontFamily:"'Segoe UI',sans-serif",padding:'32px 20px'}}>
      <AnimStyles/>
      <div style={{maxWidth:520,margin:'0 auto'}}>
        <div style={{textAlign:'center',marginBottom:32}}>
          <div style={{fontSize:24,fontWeight:900,color:DS.accent.amber,marginBottom:4}}>📐 Lumora</div>
          <div style={{fontSize:13,color:DS.text.secondary}}>Progress Report · {date}</div>
        </div>
        <div style={{background:DS.bg.surface,borderRadius:DS.radius.xl,padding:28,border:`1px solid ${DS.border}`,boxShadow:DS.shadow,marginBottom:20}}>
          <div style={{fontSize:20,fontWeight:900,color:DS.text.primary,marginBottom:2}}>{n}</div>
          <div style={{fontSize:12,color:DS.text.secondary,marginBottom:24}}>GCSE Maths · Lumora Progress Summary</div>
          <div style={{display:'flex',justifyContent:'center',marginBottom:24}}>
            <div style={{textAlign:'center',background:DS.bg.elevated,borderRadius:DS.radius.lg,padding:'20px 40px',border:`2px solid ${gradeColor}44`}}>
              <div style={{fontSize:56,fontWeight:900,color:gradeColor,lineHeight:1}}>{grade}</div>
              <div style={{fontSize:11,color:DS.text.secondary,marginTop:4}}>Predicted Grade</div>
              <div style={{fontSize:10,color:DS.text.muted}}>{avg}% average accuracy</div>
            </div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))',gap:10}}>
            {[{icon:<Zap size={18} strokeWidth={2}/>,label:'Total XP',val:`${xp} XP`},{icon:<Flame size={18} strokeWidth={2}/>,label:'Streak',val:`${streak} days`},{icon:<Trophy size={18} strokeWidth={2}/>,label:'Best Streak',val:`${best} days`},{icon:<BookOpen size={18} strokeWidth={2}/>,label:'Topics Covered',val:`${topics}`},{icon:<PenLine size={18} strokeWidth={2}/>,label:'Questions Done',val:`${qs}`},{icon:<Target size={18} strokeWidth={2}/>,label:'Accuracy',val:`${avg}%`}].map(s=>(
              <div key={s.label} style={{background:DS.bg.elevated,borderRadius:DS.radius.md,padding:'12px 10px',textAlign:'center',border:`1px solid ${DS.border}`}}>
                <div style={{fontSize:20,marginBottom:4,display:'flex',justifyContent:'center'}}>{s.icon}</div>
                <div style={{fontSize:15,fontWeight:900,color:DS.text.primary}}>{s.val}</div>
                <div style={{fontSize:9,color:DS.text.muted,marginTop:2}}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{background:DS.accent.amberDim,border:`1px solid ${DS.accent.amber}44`,borderRadius:DS.radius.lg,padding:'14px 20px',textAlign:'center'}}>
          <div style={{fontSize:12,fontWeight:800,color:DS.accent.amber,marginBottom:3}}>Powered by Lumora</div>
          <div style={{fontSize:11,color:DS.text.secondary}}>AI-powered GCSE Maths revision · AQA · Edexcel · OCR</div>
        </div>
      </div>
    </div>
  );
}

// ═══ PARENT DASHBOARD ════════════════════════════════════════════════════════
function ParentDashboard(){
  const profile=lsGet('lumora_profile',{});
  const perf=lsGet('gcse_perf',{});
  const xp=getXP();
  const streak=getStreakData();
  const [reportLoading,setReportLoading]=useState(false);
  const [copied,setCopied]=useState(false);
  const [expandedModule,setExpandedModule]=useState(null);

  const allTopics=MODULES.flatMap(m=>m.topics.map(t=>({...t,moduleLabel:m.label,moduleColor:m.color})));
  const perfEntries=Object.entries(perf).map(([id,v])=>({id,...v}));
  const totalQsDone=perfEntries.reduce((s,p)=>s+p.total,0);
  const totalCorrect=perfEntries.reduce((s,p)=>s+p.correct,0);
  const avgPct=totalQsDone>0?Math.round((totalCorrect/totalQsDone)*100):null;
  const scored=allTopics.map(t=>({...t,score:perf[t.id]?.total>=1?perf[t.id].correct/perf[t.id].total:null})).filter(x=>x.score!==null);
  const strengths=scored.slice().sort((a,b)=>b.score-a.score).slice(0,3);
  const weaknesses=scored.slice().sort((a,b)=>a.score-b.score).slice(0,3);

  const currentBoundary=avgPct!==null?GRADE_BOUNDARIES.find(b=>avgPct/100>=b.min)||GRADE_BOUNDARIES[GRADE_BOUNDARIES.length-1]:null;
  const currentGrade=currentBoundary?.grade||null;
  const gradeColor=currentBoundary?.color||DS.text.muted;

  const examDate=profile.examDate?new Date(profile.examDate):null;
  const days=examDate?Math.max(0,Math.round((examDate-new Date())/(1000*60*60*24))):null;

  const handleGenerateReport=async()=>{
    setReportLoading(true);
    const tab=window.open('','_blank');
    if(!tab){setReportLoading(false);alert('Pop-ups are blocked. Please allow pop-ups for this site.');return;}
    tab.document.write('<html><body style="font-family:\'Segoe UI\',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f0ede8;color:#1a2744"><div style="text-align:center"><div style="font-size:40px;margin-bottom:14px">📐</div><h2 style="font-weight:800;margin-bottom:6px">Generating Progress Report…</h2><p style="color:#718096">This takes a few seconds</p></div></body></html>');
    try{
      const aiResult=await aiProgressReport({
        name:profile?.name||'Student',
        grade:currentGrade?`Grade ${currentGrade}`:'not yet determined',
        avgPct:avgPct||0,
        strongestTopic:strengths[0]?.title||'not yet assessed',
        strongestPct:strengths[0]?Math.round(strengths[0].score*100):0,
        weakestTopic:weaknesses[0]?.title||'not yet assessed',
        weakestPct:weaknesses[0]?Math.round(weaknesses[0].score*100):0,
        totalQs:totalQsDone,
        board:profile?.board||'GCSE'
      });
      const html=buildReportHTML({profile,grade:currentGrade?`Grade ${currentGrade}`:'—',avgPct,totalQs:totalQsDone,totalCorrect,streakCount:streak.current,timeMinutes:totalQsDone*2,strengths,weaknesses,aiSummary:aiResult.summary,aiActions:aiResult.actions,days});
      tab.document.open();tab.document.write(html);tab.document.close();
      track('parent_report_generated',{grade:currentGrade,totalQs:totalQsDone});
    }catch(e){if(tab)tab.document.write(`<html><body style="font-family:sans-serif;padding:40px"><h2>Error generating report</h2><p>${e.message}</p></body></html>`);}
    finally{setReportLoading(false);}
  };

  const handleCopyLink=()=>{
    const shareData={n:profile?.name||'Student',xp,streak:streak.current,best:streak.best||streak.current,topics:scored.length,qs:totalQsDone,avg:avgPct||0,ts:Date.now()};
    const code=btoa(encodeURIComponent(JSON.stringify(shareData)));
    const url=`${window.location.origin}${window.location.pathname}?p=${code}`;
    navigator.clipboard.writeText(url).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2500);}).catch(()=>{alert('Could not copy. Copy this link manually:\n\n'+url);});
    track('parent_share_link_copied');
  };

  return(
    <div style={{maxWidth:640,margin:'0 auto',padding:'24px 16px'}}>
      <div style={{marginBottom:20}}>
        <div style={{fontSize:10,fontWeight:800,color:DS.text.muted,textTransform:'uppercase',letterSpacing:1.5,marginBottom:3,display:'flex',alignItems:'center',gap:5}}><GraduationCap size={12} strokeWidth={2}/>Parent Dashboard</div>
        <div style={{fontSize:20,fontWeight:900,color:DS.text.primary}}>{profile.name||'Student'}'s Progress</div>
        {days!==null&&<div style={{fontSize:12,color:DS.accent.amber,fontWeight:700,marginTop:3}}>{days} days until exam · {profile.board||'GCSE'} Maths</div>}
      </div>

      {/* Grade + key stats */}
      <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:12,marginBottom:16,alignItems:'stretch'}}>
        <div style={{background:DS.bg.surface,border:`2px solid ${gradeColor}55`,borderRadius:DS.radius.lg,padding:'20px 28px',textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
          <div style={{fontSize:60,fontWeight:900,color:gradeColor,lineHeight:1}}>{currentGrade||'—'}</div>
          <div style={{fontSize:10,fontWeight:800,color:DS.text.muted,textTransform:'uppercase',letterSpacing:1,marginTop:4}}>Predicted Grade</div>
          {avgPct!==null&&<div style={{fontSize:12,color:DS.text.secondary,marginTop:2}}>{avgPct}% accuracy</div>}
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {[{label:'Questions Done',val:totalQsDone,icon:<PenLine size={16} strokeWidth={2}/>},{label:'Day Streak',val:`${streak.current}🔥`,icon:<Flame size={16} strokeWidth={2}/>},{label:'Topics Practised',val:scored.length,icon:<BookOpen size={16} strokeWidth={2}/>},{label:'Total XP',val:`${xp}`,icon:<Zap size={16} strokeWidth={2}/>}].map(s=>(
            <div key={s.label} style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:'12px 14px',display:'flex',flexDirection:'column',gap:4}}>
              <div style={{color:DS.accent.amber}}>{s.icon}</div>
              <div style={{fontSize:18,fontWeight:900,color:DS.text.primary,lineHeight:1}}>{s.val}</div>
              <div style={{fontSize:10,color:DS.text.muted,fontWeight:600}}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Strengths & weaknesses */}
      {scored.length>0&&(
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:16}}>
          {[{label:'Top Strengths',color:DS.accent.teal,items:strengths},{label:'Areas to Improve',color:DS.accent.amber,items:weaknesses}].map(({label,color,items})=>(
            <div key={label} style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:'14px 16px'}}>
              <div style={{fontSize:10,fontWeight:800,color,textTransform:'uppercase',letterSpacing:1,marginBottom:10}}>{label}</div>
              {items.map(t=>(
                <div key={t.id} style={{marginBottom:8}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                    <div style={{fontSize:11,color:DS.text.secondary,fontWeight:600,flex:1,marginRight:6,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{t.title}</div>
                    <div style={{fontSize:11,fontWeight:800,color,flexShrink:0}}>{Math.round(t.score*100)}%</div>
                  </div>
                  <div style={{height:4,background:DS.bg.elevated,borderRadius:2,overflow:'hidden'}}><div style={{height:'100%',background:color,width:`${Math.round(t.score*100)}%`,borderRadius:2,transition:'width 0.6s ease'}}/></div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Module overview */}
      <div style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:'16px 18px',marginBottom:16}}>
        <div style={{fontSize:10,fontWeight:800,color:DS.text.muted,textTransform:'uppercase',letterSpacing:1.5,marginBottom:12}}>Progress by Topic</div>
        <div style={{display:'grid',gap:2}}>
          {MODULES.map(m=>{
            const attempted=m.topics.filter(t=>perf[t.id]?.total>0);
            const avgRatio=attempted.length>0?attempted.reduce((s,t)=>s+(perf[t.id].correct/perf[t.id].total),0)/attempted.length:null;
            const statusColor=avgRatio===null?DS.text.muted:avgRatio>=0.7?DS.accent.teal:avgRatio>=0.4?DS.accent.amber:DS.accent.red;
            const statusLabel=avgRatio===null?'Not started':avgRatio>=0.7?'On track':avgRatio>=0.4?'Needs practice':'Needs focus';
            const isOpen=expandedModule===m.id;
            const topicsSorted=[...m.topics].map(t=>({...t,ratio:perf[t.id]?.total>0?perf[t.id].correct/perf[t.id].total:null})).sort((a,b)=>{
              if(a.ratio===null&&b.ratio===null)return 0;
              if(a.ratio===null)return 1;
              if(b.ratio===null)return -1;
              return a.ratio-b.ratio; // weakest first
            });
            return(
              <div key={m.id} style={{borderRadius:DS.radius.sm,overflow:'hidden',border:`1px solid ${isOpen?DS.borderHi:DS.border}`,marginBottom:6,transition:DS.tr}}>
                <button onClick={()=>setExpandedModule(isOpen?null:m.id)} style={{width:'100%',display:'flex',alignItems:'center',gap:12,padding:'11px 14px',background:isOpen?DS.bg.overlay:'transparent',border:'none',cursor:'pointer',textAlign:'left'}}>
                  <div style={{fontSize:16,flexShrink:0,width:24,textAlign:'center'}}>{m.icon}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                      <div style={{fontSize:12,fontWeight:700,color:DS.text.primary}}>{m.label}</div>
                      <div style={{fontSize:11,fontWeight:700,color:statusColor,flexShrink:0,marginLeft:8}}>{avgRatio!==null?`${Math.round(avgRatio*100)}%`:statusLabel}</div>
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <div style={{flex:1,height:4,background:DS.bg.elevated,borderRadius:2,overflow:'hidden'}}>
                        <div style={{height:'100%',borderRadius:2,background:statusColor,width:avgRatio!==null?`${Math.round(avgRatio*100)}%`:'0%',transition:'width 0.6s ease'}}/>
                      </div>
                      <div style={{fontSize:10,color:DS.text.muted,flexShrink:0,whiteSpace:'nowrap'}}>{attempted.length}/{m.topics.length} topics</div>
                    </div>
                  </div>
                  <div style={{color:DS.text.muted,fontSize:10,flexShrink:0}}>{isOpen?'▲':'▼'}</div>
                </button>
                {isOpen&&(
                  <div style={{padding:'4px 14px 12px 50px',background:DS.bg.overlay,borderTop:`1px solid ${DS.border}`}}>
                    {topicsSorted.map(t=>{
                      const c=t.ratio===null?DS.text.muted:t.ratio>=0.7?DS.accent.teal:t.ratio>=0.4?DS.accent.amber:DS.accent.red;
                      const lbl=t.ratio===null?'Not yet practised':t.ratio>=0.7?'Strong':t.ratio>=0.4?'Needs practice':'Needs focus';
                      return(
                        <div key={t.id} style={{display:'flex',alignItems:'center',gap:10,padding:'6px 0',borderBottom:`1px solid ${DS.border}22`}}>
                          <div style={{width:6,height:6,borderRadius:'50%',background:c,flexShrink:0}}/>
                          <div style={{flex:1,fontSize:11,color:DS.text.secondary,minWidth:0,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{t.title}</div>
                          <div style={{fontSize:10,fontWeight:700,color:c,flexShrink:0,whiteSpace:'nowrap'}}>{t.ratio!==null?`${Math.round(t.ratio*100)}%`:''}</div>
                          <div style={{fontSize:10,color:c,flexShrink:0,whiteSpace:'nowrap'}}>{lbl}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Action buttons */}
      <div style={{display:'grid',gap:8}}>
        <button onClick={handleGenerateReport} disabled={reportLoading} style={{width:'100%',padding:'13px 0',borderRadius:DS.radius.md,border:'none',background:reportLoading?DS.bg.overlay:`linear-gradient(135deg,#1a2744,#2a3760)`,color:reportLoading?DS.text.muted:'#C9941A',fontWeight:900,fontSize:14,cursor:reportLoading?'not-allowed':'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,transition:DS.tr}}>
          {reportLoading?<><Loader2 size={16} strokeWidth={2} style={{animation:'spin 0.8s linear infinite'}}/> Generating…</>:<><BarChart2 size={16} strokeWidth={2}/> Generate Full PDF Report</>}
        </button>
        <button onClick={handleCopyLink} style={{width:'100%',padding:'11px 0',borderRadius:DS.radius.md,border:`1.5px solid ${copied?DS.accent.teal:DS.border}`,background:copied?DS.accent.tealDim:'transparent',color:copied?DS.accent.teal:DS.text.secondary,fontWeight:700,fontSize:13,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:7,transition:DS.tr}}>
          {copied?<><CheckCircle2 size={15} strokeWidth={2}/> Link copied!</>:<><Share2 size={15} strokeWidth={2}/> Copy shareable link for parent</>}
        </button>
      </div>

      {totalQsDone===0&&(
        <div style={{marginTop:20,background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:'20px 18px',textAlign:'center'}}>
          <GraduationCap size={28} strokeWidth={1.5} color={DS.text.muted} style={{marginBottom:8}}/>
          <div style={{fontSize:14,fontWeight:700,color:DS.text.secondary,marginBottom:4}}>No data yet</div>
          <div style={{fontSize:12,color:DS.text.muted}}>Complete some practice questions to populate the parent dashboard</div>
        </div>
      )}
    </div>
  );
}

// ═══ APP SHELL ═══════════════════════════════════════════════════════════════
export default function App(){
  const [screen,setScreen]=useState('loading');
  const [page,setPage]=useState("platform");
  const [xpV,setXpV]=useState(0);
  const [celebration,setCelebration]=useState(null);
  const [mode,setMode]=useState('sprint');
  const [showDailyModal,setShowDailyModal]=useState(false);
  const [soundOn,setSoundOn]=useState(()=>lsGet('lumora_sound',true));
  const [showSettings,setShowSettings]=useState(false);

  useEffect(()=>{
    sbGetSession().then(async user=>{
      if(user){
        initCurrentUser(user.email,user.id);
        await loadProgressFromSupabase(user.id);
        identify(user.email);
        setScreen('landing');
      } else {
        const existingProfile=localStorage.getItem('lumora_profile');
        setScreen(existingProfile?'account_create':'onboarding');
      }
    });
  },[]);

  const toggleSound=()=>{const v=!soundOn;setSoundOn(v);lsSet('lumora_sound',v);};

  // Called by DailyChallengeModal after completion; touchStreak already called inside modal
  const handleDailyAwardXP=useCallback((amount,sr)=>{
    const result=addXP(amount);
    setXpV(v=>v+1);
    if(result.levelUp){
      setCelebration({icon:result.newLevel.icon,title:`${result.newLevel.name} Level!`,body:`+${amount} XP · You reached ${result.newLevel.name}!`});
    }else if(sr?.streak===7){
      setCelebration({icon:'🔥',title:'7-Day Streak!',body:`You've studied 7 days straight! +${amount} XP 🔥`});
    }else if(sr?.streak===3){
      setCelebration({icon:'⚡',title:'3-Day Streak!',body:`Building the habit! +${amount} XP earned.`});
    }else if(sr?.milestone){
      setCelebration({icon:'🔥',title:`${sr.streak}-Day Streak!`,body:`Streak freeze earned ❄️ +${amount} XP`});
    }
  },[]);

  const handleDailyComplete=useCallback(()=>{setShowDailyModal(false);},[]);
  const handleDailySkip=useCallback(()=>{setShowDailyModal(false);},[]);

  const awardXP=useCallback((amount)=>{
    const result=addXP(amount);
    const streakResult=touchStreak();
    setXpV(v=>v+1);
    if(result.levelUp){
      setCelebration({icon:result.newLevel.icon,title:`${result.newLevel.name} Level!`,body:`You reached ${result.newLevel.name}! Keep it up! 🎉`});
    }else if(streakResult.milestone){
      setCelebration({icon:'🔥',title:`${streakResult.streak}-Day Streak!`,body:`Incredible! You've earned a streak freeze ❄️`});
    }else if(amount>=100){
      setCelebration({icon:'🏆',title:'Exam Complete!',body:`+${amount} XP earned — great effort!`});
    }
  },[]);

  const isMobile=useIsMobile();
  const sharedData=useMemo(()=>{try{const p=new URLSearchParams(window.location.search).get('p');return p?JSON.parse(decodeURIComponent(atob(p))):null;}catch{return null;}},[]);
  const handleOnboardingComplete=()=>{touchStreak();setScreen('account_create');};
  const handleLogout=()=>{clearCurrentUser();setScreen('auth');setShowSettings(false);};

  if(sharedData)return<><AnimStyles/><ProgressReport data={sharedData}/></>;
  if(screen==='loading')return<div style={{minHeight:'100vh',background:DS.bg.base,display:'flex',alignItems:'center',justifyContent:'center'}}><Loader2 size={28} strokeWidth={2} color={DS.accent.amber} style={{animation:'spin 0.8s linear infinite'}}/></div>;
  if(screen==='onboarding')return<><AnimStyles/><Onboarding onComplete={handleOnboardingComplete}/></>;
  if(screen==='account_create')return<AccountCreateScreen onCreated={()=>{touchStreak();setScreen('landing');}}/>;
  if(screen==='auth')return<LoginScreen onLogin={()=>setScreen('landing')} onRegister={()=>setScreen('onboarding')}/>;
  if(screen==='demo')return<DemoMode onSignUp={()=>setScreen('onboarding')} onBack={()=>setScreen('landing')}/>;
  if(screen==='landing')return<><AnimStyles/><LandingPage onStart={()=>setScreen('app')} onDemo={()=>setScreen('demo')}/></>;

  const xp=getXP();
  const streak=getStreakData();
  return(
    <div style={{fontFamily:"'Segoe UI',sans-serif",background:DS.bg.base,minHeight:"100vh"}}>
      <AnimStyles/>
      {celebration&&<Celebration data={celebration} onDone={()=>setCelebration(null)}/>}
      {showDailyModal&&(
        <div style={{position:'fixed',inset:0,zIndex:200}}>
          <DailyChallengeModal
            onComplete={handleDailyComplete}
            onSkip={handleDailySkip}
            onAwardXP={handleDailyAwardXP}
          />
        </div>
      )}
      {/* Top bar */}
      <div style={{background:DS.bg.surface,padding:isMobile?"0 12px":"0 16px",display:"flex",alignItems:"center",position:"sticky",top:0,zIndex:100,borderBottom:`1px solid ${DS.border}`,gap:4,boxShadow:DS.shadow,minHeight:48}}>
        <button onClick={()=>setPage('platform')} style={{fontSize:14,fontWeight:900,color:DS.accent.amber,letterSpacing:0.5,padding:"12px 0",whiteSpace:"nowrap",background:'none',border:'none',cursor:'pointer',flexShrink:0}}>📐{!isMobile&&' Lumora'}</button>
        {streak.current>0&&(
          <div style={{display:'flex',alignItems:'center',gap:3,marginLeft:isMobile?6:8,background:DS.accent.redDim,borderRadius:DS.radius.sm,padding:isMobile?'3px 6px':'3px 8px',border:'1px solid rgba(255,76,76,0.25)',flexShrink:0}}>
            <Flame size={isMobile?13:14} strokeWidth={2} color={DS.accent.red}/>
            <span style={{fontSize:isMobile?12:13,fontWeight:900,color:DS.accent.red,lineHeight:1}}>{streak.current}</span>
          </div>
        )}
        {/* Desktop-only tab pills */}
        {!isMobile&&[{id:"platform",label:<><BookOpen size={14} strokeWidth={2} style={{display:'inline',verticalAlign:'middle',marginRight:4}}/>Revision</>},{id:"generator",label:<><Zap size={14} strokeWidth={2} style={{display:'inline',verticalAlign:'middle',marginRight:4}}/>Generator</>},{id:"mock",label:<><FileText size={14} strokeWidth={2} style={{display:'inline',verticalAlign:'middle',marginRight:4}}/>Mock</>},{id:"report",label:<><GraduationCap size={14} strokeWidth={2} style={{display:'inline',verticalAlign:'middle',marginRight:4}}/>Report</>}].map(tab=>(
          <button key={tab.id} onClick={()=>{setPage(tab.id);track('tab_switched',{tab:tab.id});}} style={{padding:"6px 12px",margin:"6px 0",borderRadius:DS.radius.sm,border:"none",background:page===tab.id?DS.accent.amberDim:"transparent",cursor:"pointer",color:page===tab.id?DS.accent.amber:DS.text.muted,fontWeight:page===tab.id?800:500,fontSize:12,transition:DS.tr,whiteSpace:"nowrap",flexShrink:0}}>
            {tab.label}
          </button>
        ))}
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:isMobile?4:8,padding:'0 2px'}}>
          {mode==='sprint'&&!isMobile&&(
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <div style={{width:60,height:5,background:DS.bg.elevated,borderRadius:3,overflow:'hidden'}}>
                <div style={{height:'100%',background:DS.accent.amber,width:`${Math.min(100,Math.round(((xp-(getLevel(xp).min))/((LEVELS.find(l=>l.min>xp)?.min||xp+1)-(getLevel(xp).min)))*100))}%`,transition:'width 0.6s ease',borderRadius:3}}/>
              </div>
              <div style={{fontSize:11,color:DS.accent.amber,fontWeight:800}}>{xp} XP</div>
            </div>
          )}
          {!isMobile&&(()=>{const p=lsGet('lumora_profile',{});return p.name?(
            <div style={{fontSize:12,color:DS.text.secondary,fontWeight:600,whiteSpace:'nowrap',maxWidth:80,overflow:'hidden',textOverflow:'ellipsis'}}>Hi {p.name.split(' ')[0]}</div>
          ):null;})()}
          {!isMobile&&<button onClick={toggleSound} title={soundOn?'Mute sounds':'Enable sounds'} style={{background:'none',border:`1px solid ${DS.border}`,borderRadius:DS.radius.sm,padding:'5px 8px',cursor:'pointer',color:DS.text.muted,lineHeight:1,display:'flex',alignItems:'center'}}>{soundOn?<Volume2 size={15} strokeWidth={2}/>:<VolumeX size={15} strokeWidth={2}/>}</button>}
          <StudyModeToggle mode={mode} setMode={setMode}/>
          <button onClick={()=>setShowSettings(true)} title="Account settings" style={{background:'none',border:`1px solid ${DS.border}`,borderRadius:DS.radius.sm,padding:'5px 8px',cursor:'pointer',color:DS.text.muted,lineHeight:1,display:'flex',alignItems:'center'}}><Settings size={16} strokeWidth={2}/></button>
        </div>
        {showSettings&&<SettingsPanel onClose={()=>setShowSettings(false)} onLogout={handleLogout}/>}
      </div>

      {/* Page content */}
      <div style={isMobile?{paddingBottom:68}:{}}>
        {page==="platform"&&<Platform onXP={awardXP} xpV={xpV} mode={mode} onOpenDaily={()=>setShowDailyModal(true)}/>}
        {page==="generator"&&<Generator/>}
        {page==="mock"&&<MockExam onXP={awardXP} mode={mode}/>}
        {page==="report"&&<ParentDashboard/>}
      </div>

      {/* Mobile bottom nav */}
      {isMobile&&(
        <div style={{position:'fixed',bottom:0,left:0,right:0,zIndex:100,background:DS.bg.surface,borderTop:`1px solid ${DS.border}`,display:'flex',boxShadow:'0 -2px 12px rgba(0,0,0,0.3)'}}>
          {[{id:"platform",icon:<BookOpen size={20} strokeWidth={2}/>,label:"Revision"},{id:"generator",icon:<Zap size={20} strokeWidth={2}/>,label:"Generator"},{id:"mock",icon:<FileText size={20} strokeWidth={2}/>,label:"Mock"},{id:"report",icon:<GraduationCap size={20} strokeWidth={2}/>,label:"Report"}].map(tab=>{
            const active=page===tab.id;
            return(
              <button key={tab.id} onClick={()=>{setPage(tab.id);track('tab_switched',{tab:tab.id});}} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:3,padding:'10px 4px 12px',border:'none',background:'transparent',cursor:'pointer',color:active?DS.accent.amber:DS.text.muted,transition:DS.tr}}>
                <div style={{color:active?DS.accent.amber:DS.text.muted,transition:DS.tr}}>{tab.icon}</div>
                <div style={{fontSize:10,fontWeight:active?800:500,letterSpacing:0.2}}>{tab.label}</div>
                {active&&<div style={{position:'absolute',bottom:0,width:32,height:2,background:DS.accent.amber,borderRadius:'2px 2px 0 0'}}/>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══ QCARD (Platform static questions — with SM-2 + AI marking) ═══════════
// Deterministic peer stat — consistent per question, varies by difficulty
function peerStat(topicId,idx,diff){
  // Simple hash: sum of char codes × idx
  const seed=(topicId.split('').reduce((a,c)=>a+c.charCodeAt(0),0)*(idx+1))%100;
  const base={Starter:[22,38],Mid:[45,62],Killer:[65,80]}[diff]||[45,62];
  return base[0]+Math.round((seed/100)*(base[1]-base[0]));
}

function QCard({q,idx,topicId,onAnswered,onXP,isAI=false}){
  const [open,setOpen]=useState(false);
  const [answered,setAnswered]=useState(null);
  const [working,setWorking]=useState('');
  const [aiResult,setAiResult]=useState(null);
  const [aiLoading,setAiLoading]=useState(false);
  const [showSocratic,setShowSocratic]=useState(false);
  const qid=`${topicId}:${idx}`;
  const d=DIFF[q.diff]||DIFF.Mid;
  const peerWrong=peerStat(topicId,idx,q.diff);

  const handleAnswer=(correct)=>{
    setAnswered(correct?'right':'wrong');
    if(!isAI)sm2Update(qid,correct?4:1);
    recordPerf(topicId,correct);
    if(onXP)onXP(correct?35:10);
    if(onAnswered)onAnswered();
    track('question_answered',{topicId,correct,diff:q.diff,marks:q.marks,isAI:!!isAI});
  };

  const handleAI=async()=>{
    setAiLoading(true);setAiResult(null);
    track('ai_marking_used',{topicId,diff:q.diff,marks:q.marks});
    try{const r=await aiMark(q.q,q.marks,q.ms,working);setAiResult(r);}
    catch(e){setAiResult({error:e.message});}
    setAiLoading(false);
  };

  const borderColor=answered==='right'?DS.accent.teal:answered==='wrong'?DS.accent.red:DS.border;

  return(
    <div style={{border:`1.5px solid ${borderColor}`,borderRadius:DS.radius.md,marginBottom:12,overflow:'hidden',background:DS.bg.surface,transition:DS.tr,position:'relative'}}>
      <div style={{position:'absolute',left:0,top:0,bottom:0,width:3,background:d.c,borderRadius:'3px 0 0 3px'}}/>
      <div style={{padding:'14px 18px 14px 22px'}}>
        <div style={{display:'flex',gap:8,marginBottom:8,flexWrap:'wrap',alignItems:'center'}}>
          {isAI
            ?<span style={{background:'rgba(155,89,182,0.15)',color:'#9B59B6',fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:5,border:'1px solid rgba(155,89,182,0.3)',flexShrink:0,display:'inline-flex',alignItems:'center',gap:3}}><Sparkles size={10} strokeWidth={2}/>AI</span>
            :<span style={{width:24,height:24,borderRadius:'50%',background:DS.bg.elevated,color:DS.accent.amber,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:11,flexShrink:0}}>{idx+1}</span>
          }
          <span style={{background:d.bg,color:d.c,fontSize:11,fontWeight:800,padding:'2px 8px',borderRadius:6}}>{q.diff}</span>
          <span style={{fontSize:11,color:DS.text.muted,fontWeight:600}}>[{q.marks} mark{q.marks>1?'s':''}]</span>
          {!answered&&<span style={{fontSize:10,color:DS.text.muted,fontWeight:600,display:'inline-flex',alignItems:'center',gap:3,padding:'2px 7px',borderRadius:10,border:`1px solid ${DS.border}`,background:DS.bg.elevated}} title="Based on difficulty tier"><Users size={10} strokeWidth={2}/>{peerWrong}% find this hard</span>}
          {answered&&<span style={{fontSize:11,fontWeight:800,color:answered==='right'?DS.accent.teal:DS.accent.red,display:'inline-flex',alignItems:'center',gap:3}}>{answered==='right'?<><Check size={13} strokeWidth={2.5}/>Got it</>:<><X size={13} strokeWidth={2.5}/>Wrong</>}</span>}
        </div>
        <p style={{margin:'0 0 12px',fontSize:15,lineHeight:1.65,color:DS.text.primary,whiteSpace:'pre-line'}}>{q.q}</p>
        <div>
          <div style={{fontSize:11,fontWeight:700,color:DS.text.secondary,marginBottom:4}}>Your working:</div>
          <textarea value={working} onChange={e=>!answered&&setWorking(e.target.value)} disabled={!!answered} placeholder="Write your working here..." style={{width:'100%',minHeight:68,padding:10,borderRadius:DS.radius.sm,border:`1.5px solid ${DS.border}`,fontSize:13,fontFamily:'inherit',resize:'vertical',boxSizing:'border-box',outline:'none',background:answered?DS.bg.overlay:DS.bg.elevated,color:DS.text.primary,opacity:answered?0.7:1}} onFocus={e=>{if(!answered)e.target.style.borderColor=DS.accent.amber;}} onBlur={e=>e.target.style.borderColor=DS.border}/>
        </div>
      </div>

      {open&&(
        <div style={{borderTop:`1px solid ${DS.border}`,background:DS.bg.elevated,padding:'14px 18px 14px 22px'}}>
          <div style={{fontSize:10,fontWeight:800,color:DS.accent.teal,textTransform:'uppercase',letterSpacing:1.5,marginBottom:8,borderLeft:`3px solid ${DS.accent.teal}`,paddingLeft:8}}>Mark Scheme</div>
          {q.ms.map((m,i)=><div key={i} style={{fontSize:13,color:DS.text.primary,padding:'3px 0',display:'flex',gap:8}}><span style={{color:DS.accent.teal,fontWeight:700}}>›</span>{m}</div>)}
          {q.insight&&<div style={{background:DS.bg.surface,borderLeft:`3px solid ${DS.accent.teal}`,borderRadius:`0 ${DS.radius.sm}px ${DS.radius.sm}px 0`,padding:'10px 14px',marginTop:10}}>
            <div style={{fontSize:10,fontWeight:800,color:DS.accent.teal,display:'flex',alignItems:'center',gap:4}}><Lightbulb size={12} strokeWidth={2}/>Examiner Insight</div>
            <p style={{margin:'4px 0 0',fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{q.insight}</p>
          </div>}

          {answered&&(
            <div style={{marginTop:10,background:answered==='right'?DS.accent.tealDim:DS.bg.overlay,borderRadius:DS.radius.sm,padding:'8px 12px',border:`1px solid ${answered==='right'?DS.accent.teal+'33':DS.border}`,display:'flex',alignItems:'center',gap:8}}>
              <Users size={13} strokeWidth={2} color={answered==='right'?DS.accent.teal:DS.text.muted}/>
              <span style={{fontSize:12,color:answered==='right'?DS.accent.teal:DS.text.muted}}>
                {answered==='right'
                  ?<><strong>{peerWrong}%</strong> of students find this hard — you nailed it!</>
                  :<>You're not alone — <strong>{peerWrong}%</strong> of students also struggle with this one.</>
                }
              </span>
            </div>
          )}
          {!answered&&(
            <div style={{marginTop:14}}>
              <div style={{fontSize:11,fontWeight:700,color:DS.text.secondary,marginBottom:8}}>After checking the mark scheme, how did you do?</div>
              <div style={{display:'flex',gap:8}}>
                <button onClick={()=>handleAnswer(true)} style={{flex:1,padding:9,borderRadius:DS.radius.sm,border:'none',background:DS.accent.teal,color:DS.bg.base,fontWeight:800,fontSize:12,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:5}}><Check size={13} strokeWidth={2.5}/> Got It</button>
                <button onClick={()=>handleAnswer(false)} style={{flex:1,padding:9,borderRadius:DS.radius.sm,border:'none',background:DS.accent.red,color:'#fff',fontWeight:800,fontSize:12,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:5}}><X size={13} strokeWidth={2.5}/> Wrong</button>
              </div>
            </div>
          )}

          {working.trim()&&(
            <div style={{marginTop:12}}>
              <button onClick={handleAI} disabled={aiLoading} style={{width:'100%',padding:9,borderRadius:DS.radius.sm,border:`1.5px solid ${DS.borderHi}`,background:aiLoading?DS.bg.overlay:DS.bg.surface,color:aiLoading?DS.text.muted:DS.accent.amber,fontWeight:800,fontSize:12,cursor:aiLoading?'not-allowed':'pointer',transition:DS.tr}}>
                {aiLoading?'Marking your working...':'Get AI Feedback on My Working'}
              </button>
              {aiResult&&!aiResult.error&&(
                <div style={{marginTop:10,background:DS.bg.surface,border:`1.5px solid ${DS.borderHi}`,borderRadius:DS.radius.md,padding:14}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                    <div style={{fontSize:12,fontWeight:800,color:DS.text.primary}}>AI Feedback</div>
                    <div style={{width:44,height:44,borderRadius:'50%',background:aiResult.marksEarned===q.marks?DS.accent.tealDim:aiResult.marksEarned>0?DS.accent.amberDim:DS.accent.redDim,border:`2px solid ${aiResult.marksEarned===q.marks?DS.accent.teal:aiResult.marksEarned>0?DS.accent.amber:DS.accent.red}`,display:'flex',alignItems:'center',justifyContent:'center'}}>
                      <span style={{fontSize:12,fontWeight:900,color:aiResult.marksEarned===q.marks?DS.accent.teal:aiResult.marksEarned>0?DS.accent.amber:DS.accent.red}}>{aiResult.marksEarned}/{q.marks}</span>
                    </div>
                  </div>
                  {aiResult.feedback&&<div style={{borderLeft:`3px solid ${DS.accent.teal}`,paddingLeft:10,marginBottom:8}}><div style={{fontSize:9,fontWeight:800,color:DS.accent.teal,marginBottom:2}}>WHAT YOU GOT RIGHT</div><p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{aiResult.feedback}</p></div>}
                  {aiResult.improvements&&<div style={{borderLeft:`3px solid ${DS.accent.amber}`,paddingLeft:10,marginBottom:8}}><div style={{fontSize:9,fontWeight:800,color:DS.accent.amber,marginBottom:2}}>WHAT TO IMPROVE</div><p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{aiResult.improvements}</p></div>}
                  {aiResult.breakdown?.length>0&&<div style={{background:DS.bg.elevated,borderRadius:DS.radius.sm,padding:'8px 12px',marginTop:4}}><div style={{fontSize:9,fontWeight:800,color:DS.text.muted,marginBottom:4}}>MARK BREAKDOWN</div>{aiResult.breakdown.map((m,i)=><div key={i} style={{fontSize:12,color:DS.text.secondary,padding:'2px 0',fontFamily:'monospace'}}>{m}</div>)}</div>}
                  <button onClick={()=>{setShowSocratic(s=>!s);if(!showSocratic)track('socratic_tutor_opened',{topicId,diff:q.diff});}} style={{width:'100%',marginTop:12,padding:'11px 16px',borderRadius:DS.radius.md,border:`1.5px solid ${DS.accent.teal}55`,background:showSocratic?DS.accent.teal+'22':DS.bg.elevated,color:DS.accent.teal,fontWeight:800,fontSize:13,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,transition:DS.tr}}>
                    <MessageCircle size={15} strokeWidth={2}/>{showSocratic?'Hide AI Tutor':'Talk it through with your AI Tutor →'}
                  </button>
                  {showSocratic&&<div style={{marginTop:10,borderRadius:DS.radius.md,overflow:'hidden',border:`1px solid ${DS.accent.teal}33`}}><SocraticChat question={q.q} ms={q.ms} aiResult={aiResult} maxMarks={q.marks}/></div>}
                </div>
              )}
              {aiResult?.error&&<div style={{marginTop:8,background:DS.accent.redDim,borderRadius:DS.radius.sm,padding:'8px 12px',color:DS.accent.red,fontSize:12,border:`1px solid ${DS.accent.red}33`}}>{aiResult.error}</div>}
            </div>
          )}
        </div>
      )}

      <div style={{padding:'8px 18px 8px 22px',display:'flex',gap:8,background:DS.bg.base,borderTop:`1px solid ${DS.border}`}}>
        <button onClick={()=>setOpen(!open)} style={{flex:1,padding:'7px 0',borderRadius:DS.radius.sm,border:`1.5px solid ${open?DS.accent.amber:DS.border}`,background:open?DS.accent.amberDim:'transparent',color:open?DS.accent.amber:DS.text.secondary,fontSize:11,fontWeight:700,cursor:'pointer',transition:DS.tr}}>
          {open?'Hide Answer':'Show Mark Scheme'}
        </button>
      </div>
    </div>
  );
}

// ═══ TOPIC PAGE ═══════════════════════════════════════════════════════════════
const Divider=({label,color})=>(
  <div style={{display:'flex',alignItems:'center',gap:8,margin:'4px 0 12px'}}>
    <div style={{fontSize:9,fontWeight:800,color:color||DS.text.muted,textTransform:'uppercase',letterSpacing:1.5,whiteSpace:'nowrap'}}>{label}</div>
    <div style={{flex:1,height:1,background:DS.border}}/>
  </div>
);
function TopicPage({topic,moduleLabel,onAnswered,onXP}){
  const [tab,setTab]=useState("questions");
  const [aiQs,setAiQs]=useState([]);
  const [aiLoading,setAiLoading]=useState(false);
  const [aiError,setAiError]=useState(null);
  // Learn tab state
  const [learnMode,setLearnMode]=useState('flashcards');
  const [cardIdx,setCardIdx]=useState(0);
  const [cardFlipped,setCardFlipped]=useState(false);
  const [mcqData,setMcqData]=useState(null);
  const [mcqLoading,setMcqLoading]=useState(false);
  const [mcqError,setMcqError]=useState(null);
  const [mcqAnswers,setMcqAnswers]=useState({});
  const [stepsData,setStepsData]=useState(null);
  const [stepsLoading,setStepsLoading]=useState(false);
  const [stepsRevealed,setStepsRevealed]=useState(0);
  const [explainText,setExplainText]=useState('');
  const [explainResult,setExplainResult]=useState(null);
  const [explainLoading,setExplainLoading]=useState(false);
  // Creative modalities state
  const [vizData,setVizData]=useState(null);
  const [vizLoading,setVizLoading]=useState(false);
  const [errorHuntData,setErrorHuntData]=useState(null);
  const [errorHuntLoading,setErrorHuntLoading]=useState(false);
  const [errorHuntSelected,setErrorHuntSelected]=useState(new Set());
  const [errorHuntRevealed,setErrorHuntRevealed]=useState(false);
  const [realWorldData,setRealWorldData]=useState(null);
  const [realWorldLoading,setRealWorldLoading]=useState(false);
  const [realWorldSolutionShown,setRealWorldSolutionShown]=useState(false);
  const flashCards=[
    ...topic.markScheme.map((m,i)=>({front:`Mark Scheme Rule ${i+1}`,back:m})),
    {front:`Memory Aid: ${topic.analogy.title}`,back:topic.analogy.lines.filter(l=>l.trim()).join('\n')},
    ...topic.mistakes.map(m=>({front:`Common Mistake — what's wrong here?`,back:m})),
  ];
  const handleLoadMCQ=async()=>{
    if(mcqData)return;
    setMcqLoading(true);setMcqError(null);
    try{const d=await aiMCQ(topic.title,moduleLabel||'');setMcqData(d.questions||[]);}
    catch(e){setMcqError(e.message);}
    setMcqLoading(false);
  };
  const handleLoadSteps=async()=>{
    if(stepsData)return;
    setStepsLoading(true);
    try{const d=await aiWorkedSteps(topic.title,topic.questions[1]?.q||topic.questions[0]?.q||topic.title);setStepsData(d);}
    catch(e){setStepsData({error:e.message});}
    setStepsLoading(false);
  };
  const handleExplainSubmit=async()=>{
    if(!explainText.trim())return;
    setExplainLoading(true);setExplainResult(null);
    try{const d=await aiExplainMark(topic.title,explainText);setExplainResult(d);}
    catch(e){setExplainResult({error:e.message});}
    setExplainLoading(false);
  };
  const handleLoadViz=async()=>{
    if(vizData)return;
    setVizLoading(true);
    try{const d=await aiVisualDiagram(topic.title,moduleLabel||'');setVizData(d);}
    catch(e){setVizData({error:e.message});}
    setVizLoading(false);
  };
  const handleLoadErrorHunt=async()=>{
    if(errorHuntData)return;
    setErrorHuntLoading(true);
    try{const d=await aiErrorHunt(topic.title,topic.questions[1]?.q||topic.questions[0]?.q||topic.title);setErrorHuntData(d);}
    catch(e){setErrorHuntData({error:e.message});}
    setErrorHuntLoading(false);
  };
  const handleLoadRealWorld=async()=>{
    if(realWorldData)return;
    setRealWorldLoading(true);
    try{const d=await aiRealWorld(topic.title,moduleLabel||'');setRealWorldData(d);}
    catch(e){setRealWorldData({error:e.message});}
    setRealWorldLoading(false);
  };
  const tabs=[{id:"questions",l:"Questions"},{id:"learn",l:"🎓 Learn"},{id:"boards",l:"Board Diff"},{id:"concept",l:"Core Concept"},{id:"markscheme",l:"Mark Scheme"},{id:"mistakes",l:"Mistakes"}];
  const boardColors={AQA:{bd:'#1B2A4A',c:'#7B9FC4'},Edexcel:{bd:'#C0392B',c:'#E07B6A'},OCR:{bd:'#0D6E72',c:'#00C9B1'},'Edexcel IGCSE':{bd:'#7B2D8B',c:'#C39BD3'}};
  const hasKey=!!import.meta.env.VITE_ANTHROPIC_API_KEY;

  const handleGenerate=async()=>{
    setAiLoading(true);setAiError(null);
    const board=lsGet('lumora_profile',null)?.board||'AQA';
    const tp=lsGet('gcse_perf',{})[topic.id];
    const ratio=tp?.total>0?tp.correct/tp.total:0;
    const diffMix=ratio>=0.7
      ?'Mid and Killer — challenging multi-step and proof questions'
      :'Starter and Mid — accessible questions building to multi-step';
    try{
      const data=await generateTopicQs(topic.title,moduleLabel||'',board,diffMix);
      if(data?.questions?.length>0){setAiQs(prev=>[...prev,...data.questions.slice(0,3)]);}
      else{setAiError('No questions returned — please try again.');}
    }catch(e){setAiError(e.message);}
    setAiLoading(false);
  };



  return(
    <div>
      <div style={{display:'flex',gap:4,marginBottom:18,overflowX:'auto',paddingBottom:2}}>
        {tabs.map(t=><button key={t.id} onClick={()=>setTab(t.id)} style={{padding:'7px 14px',borderRadius:DS.radius.sm,border:`1.5px solid ${tab===t.id?DS.accent.amber:DS.border}`,background:tab===t.id?DS.accent.amberDim:DS.bg.surface,color:tab===t.id?DS.accent.amber:DS.text.secondary,fontWeight:700,fontSize:12,cursor:'pointer',flexShrink:0,transition:DS.tr}}>{t.l}</button>)}
      </div>

      {tab==="questions"&&(
        <div>
          <Divider label="Foundation Questions"/>
          {topic.questions.map((q,i)=><QCard key={i} q={q} idx={i} topicId={topic.id} onAnswered={onAnswered} onXP={onXP}/>)}

          {aiQs.length>0&&(
            <>
              <Divider label="AI Generated" color="#9B59B6"/>
              {aiQs.map((q,i)=>(
                <QCard key={`ai-${i}`} q={q} idx={topic.questions.length+i} topicId={topic.id} onAnswered={onAnswered} onXP={onXP} isAI={true}/>
              ))}
            </>
          )}

          {aiError&&(
            <div style={{background:DS.accent.redDim,border:`1px solid ${DS.accent.red}33`,borderRadius:DS.radius.sm,padding:'8px 12px',marginBottom:10,fontSize:12,color:DS.accent.red}}>{aiError}</div>
          )}

          <button onClick={handleGenerate} disabled={aiLoading||!hasKey}
            style={{width:'100%',padding:'13px',borderRadius:DS.radius.md,border:`1.5px dashed ${aiLoading?DS.border:'rgba(155,89,182,0.45)'}`,background:'rgba(155,89,182,0.06)',color:aiLoading||!hasKey?DS.text.muted:'#9B59B6',fontWeight:700,fontSize:13,cursor:aiLoading||!hasKey?'not-allowed':'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,transition:DS.tr,marginTop:4}}>
            {aiLoading
              ?<><Loader2 size={14} strokeWidth={2} style={{animation:'spin 0.8s linear infinite',color:'#9B59B6'}}/>Generating questions…</>
              :<><Sparkles size={14} strokeWidth={2}/> Generate 3 More Questions{aiQs.length>0?` (${aiQs.length} generated so far)`:''}</>
            }
          </button>
          {!hasKey&&<div style={{textAlign:'center',fontSize:11,color:DS.text.muted,marginTop:6}}>Add VITE_ANTHROPIC_API_KEY to .env.local to enable AI generation</div>}
        </div>
      )}

      {tab==="boards"&&(()=>{
        const userBoard=lsGet('lumora_profile',{}).board||'';
        const entries=Object.entries(topic.boards);
        const hasIGCSE=topic.boards['Edexcel IGCSE'];
        const showIGCSEFallback=userBoard==='Edexcel IGCSE'&&!hasIGCSE;
        return<>
          {showIGCSEFallback&&(
            <div style={{background:'rgba(123,45,139,0.1)',border:'1px solid rgba(123,45,139,0.3)',borderRadius:DS.radius.md,padding:'12px 16px',marginBottom:12,display:'flex',gap:10,alignItems:'flex-start'}}>
              <span style={{flexShrink:0,display:'flex',alignItems:'center'}}><Info size={16} strokeWidth={2} color="#C39BD3"/></span>
              <div style={{fontSize:12,color:'#C39BD3',lineHeight:1.5}}><strong>Edexcel IGCSE (4MA1):</strong> No major differences for this topic — Edexcel guidance below applies directly. IGCSE-specific content (Functions, Calculus) is in the dedicated topics.</div>
            </div>
          )}
          {entries.map(([b,txt])=>{
            const bc=boardColors[b]||{bd:DS.border,c:DS.text.secondary};
            return<div key={b} style={{background:DS.bg.elevated,borderLeft:`3px solid ${bc.bd}`,borderRadius:DS.radius.md,padding:'14px 18px',marginBottom:10,border:`1px solid ${DS.border}`}}>
              <span style={{background:bc.bd,color:'#fff',fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:4,letterSpacing:1,display:'inline-block',marginBottom:8}}>{b}</span>
              <p style={{margin:0,fontSize:13,lineHeight:1.6,color:DS.text.secondary}}>{txt}</p>
            </div>;
          })}
        </>;
      })()}
      {tab==="concept"&&<div style={{background:DS.bg.elevated,borderRadius:DS.radius.lg,padding:24,border:`1px solid ${DS.border}`}}>
        <div style={{fontSize:36,marginBottom:8}}>{topic.analogy.icon}</div>
        <div style={{fontSize:17,fontWeight:800,color:DS.accent.amber,marginBottom:14}}>{topic.analogy.title}</div>
        {topic.analogy.lines.map((l,i)=><div key={i} style={{fontSize:13,lineHeight:1.8,color:l.startsWith(" ")?DS.accent.teal:DS.text.primary,fontFamily:l.startsWith(" ")?"monospace":"inherit"}}>{l||" "}</div>)}
      </div>}
      {tab==="markscheme"&&<div style={{background:DS.bg.elevated,borderLeft:`3px solid ${DS.accent.teal}`,borderRadius:DS.radius.md,padding:20,border:`1px solid ${DS.border}`}}>
        <div style={{fontSize:10,fontWeight:800,color:DS.accent.teal,textTransform:'uppercase',letterSpacing:1.5,marginBottom:12}}>What Earns Marks</div>
        {topic.markScheme.map((m,i)=><div key={i} style={{display:'flex',gap:10,marginBottom:10}}><div style={{width:6,height:6,borderRadius:'50%',background:DS.accent.teal,marginTop:7,flexShrink:0}}/><p style={{margin:0,fontSize:13,lineHeight:1.6,color:DS.text.secondary}}>{m}</p></div>)}
      </div>}
      {tab==="mistakes"&&<div style={{background:DS.bg.elevated,borderLeft:`3px solid ${DS.accent.red}`,borderRadius:DS.radius.md,padding:20,border:`1px solid ${DS.border}`}}>
        <div style={{fontSize:10,fontWeight:800,color:DS.accent.red,textTransform:'uppercase',letterSpacing:1.5,marginBottom:12}}>Common Mistakes</div>
        {topic.mistakes.map((m,i)=><div key={i} style={{display:'flex',gap:10,marginBottom:12}}><div style={{minWidth:20,height:20,borderRadius:'50%',background:DS.accent.redDim,color:DS.accent.red,border:`1px solid ${DS.accent.red}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:800,flexShrink:0}}>{i+1}</div><p style={{margin:0,fontSize:13,lineHeight:1.6,color:DS.text.secondary}}>{m}</p></div>)}
      </div>}

      {tab==="learn"&&(
        <div>
          {/* Modality selector */}
          <div style={{marginBottom:6}}>
            <div style={{fontSize:9,fontWeight:800,color:DS.text.muted,textTransform:'uppercase',letterSpacing:1.5,marginBottom:8}}>Standard</div>
            <div style={{display:'flex',gap:6,marginBottom:10,flexWrap:'wrap'}}>
              {[{id:'flashcards',icon:'📇',label:'Flashcards'},{id:'mcq',icon:'🎯',label:'Multiple Choice'},{id:'steps',icon:'🪜',label:'Worked Steps'},{id:'explain',icon:'💬',label:'Explain It'}].map(m=>(
                <button key={m.id} onClick={()=>setLearnMode(m.id)} style={{padding:'7px 14px',borderRadius:DS.radius.sm,border:`1.5px solid ${learnMode===m.id?DS.accent.teal:DS.border}`,background:learnMode===m.id?DS.accent.tealDim:DS.bg.surface,color:learnMode===m.id?DS.accent.teal:DS.text.secondary,fontWeight:700,fontSize:12,cursor:'pointer',flexShrink:0,transition:DS.tr,display:'flex',alignItems:'center',gap:5}}>{m.icon} {m.label}</button>
              ))}
            </div>
            <div style={{fontSize:9,fontWeight:800,color:DS.accent.amber,textTransform:'uppercase',letterSpacing:1.5,marginBottom:8,display:'flex',alignItems:'center',gap:4}}><Sparkles size={10} strokeWidth={2}/>AI-Powered</div>
            <div style={{display:'flex',gap:6,marginBottom:18,flexWrap:'wrap'}}>
              {[{id:'visual',icon:'🎨',label:'Visual Diagram'},{id:'errors',icon:'🕵️',label:'Error Hunt'},{id:'story',icon:'🌍',label:'Real World'}].map(m=>(
                <button key={m.id} onClick={()=>setLearnMode(m.id)} style={{padding:'7px 14px',borderRadius:DS.radius.sm,border:`1.5px solid ${learnMode===m.id?DS.accent.amber:DS.border}`,background:learnMode===m.id?DS.accent.amberDim:DS.bg.surface,color:learnMode===m.id?DS.accent.amber:DS.text.secondary,fontWeight:700,fontSize:12,cursor:'pointer',flexShrink:0,transition:DS.tr,display:'flex',alignItems:'center',gap:5}}>{m.icon} {m.label}</button>
              ))}
            </div>
          </div>

          {/* Flashcards */}
          {learnMode==='flashcards'&&(
            <div>
              <div style={{textAlign:'center',fontSize:11,color:DS.text.muted,marginBottom:12}}>Card {cardIdx+1} of {flashCards.length} · Tap to flip</div>
              <div onClick={()=>setCardFlipped(f=>!f)} style={{background:cardFlipped?DS.accent.tealDim:DS.bg.elevated,border:`1.5px solid ${cardFlipped?DS.accent.teal:DS.border}`,borderRadius:DS.radius.lg,padding:32,textAlign:'center',cursor:'pointer',minHeight:170,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12,transition:DS.tr,userSelect:'none'}}>
                <div style={{fontSize:10,fontWeight:800,color:cardFlipped?DS.accent.teal:DS.text.muted,textTransform:'uppercase',letterSpacing:1.5}}>{cardFlipped?'Answer ↓':'Tap to reveal →'}</div>
                <p style={{margin:0,fontSize:14,lineHeight:1.75,color:DS.text.primary,whiteSpace:'pre-line'}}>{cardFlipped?flashCards[cardIdx].back:flashCards[cardIdx].front}</p>
              </div>
              <div style={{display:'flex',gap:8,marginTop:12,justifyContent:'center'}}>
                <button onClick={()=>{setCardIdx(i=>(i-1+flashCards.length)%flashCards.length);setCardFlipped(false);}} style={{padding:'8px 22px',borderRadius:DS.radius.sm,border:`1px solid ${DS.border}`,background:DS.bg.surface,color:DS.text.secondary,cursor:'pointer',fontWeight:700,fontSize:13}}>← Prev</button>
                <button onClick={()=>{setCardIdx(i=>(i+1)%flashCards.length);setCardFlipped(false);}} style={{padding:'8px 22px',borderRadius:DS.radius.sm,border:`1px solid ${DS.border}`,background:DS.bg.surface,color:DS.text.secondary,cursor:'pointer',fontWeight:700,fontSize:13}}>Next →</button>
              </div>
            </div>
          )}

          {/* Multiple Choice */}
          {learnMode==='mcq'&&(
            <div>
              {!mcqData&&!mcqLoading&&(
                <div style={{textAlign:'center',padding:32}}>
                  <div style={{fontSize:32,marginBottom:12,display:'flex',justifyContent:'center'}}><Target size={32} strokeWidth={1.5} color={DS.accent.amber}/></div>
                  <p style={{fontSize:14,color:DS.text.secondary,marginBottom:20}}>AI generates 4 multiple-choice questions — pick the right answer and see why</p>
                  <button onClick={handleLoadMCQ} disabled={!hasKey} style={{padding:'10px 28px',borderRadius:DS.radius.md,border:'none',background:DS.accent.teal,color:DS.bg.base,fontWeight:800,fontSize:13,cursor:hasKey?'pointer':'not-allowed',opacity:hasKey?1:0.5}}>Generate Questions</button>
                  {mcqError&&<div style={{marginTop:12,color:DS.accent.red,fontSize:12}}>{mcqError}</div>}
                  {!hasKey&&<div style={{marginTop:8,fontSize:11,color:DS.text.muted}}>Requires VITE_ANTHROPIC_API_KEY</div>}
                </div>
              )}
              {mcqLoading&&<div style={{textAlign:'center',padding:40,color:DS.text.secondary}}><Loader2 size={32} strokeWidth={2} style={{animation:'spin 0.8s linear infinite',color:DS.accent.teal,margin:'0 auto 12px',display:'block'}}/>Generating questions…</div>}
              {mcqData&&mcqData.map((q,qi)=>{
                const selected=mcqAnswers[qi];
                return(
                  <div key={qi} style={{background:DS.bg.elevated,border:`1.5px solid ${selected?selected===q.answer?DS.accent.teal:DS.accent.red:DS.border}`,borderRadius:DS.radius.md,padding:18,marginBottom:14,transition:DS.tr}}>
                    <div style={{fontSize:13,fontWeight:700,color:DS.text.primary,marginBottom:12,lineHeight:1.5}}>Q{qi+1}. {q.q}</div>
                    <div style={{display:'flex',flexDirection:'column',gap:6}}>
                      {q.options.map((opt,oi)=>{
                        const letter=String.fromCharCode(65+oi);
                        const isSelected=selected===letter;
                        const isCorrect=q.answer===letter;
                        const revealed=!!selected;
                        let bg=DS.bg.surface,border=DS.border,color=DS.text.secondary;
                        if(revealed&&isCorrect){bg=DS.accent.tealDim;border=DS.accent.teal;color=DS.accent.teal;}
                        else if(revealed&&isSelected&&!isCorrect){bg=DS.accent.redDim;border=DS.accent.red;color=DS.accent.red;}
                        return(
                          <button key={oi} onClick={()=>!selected&&setMcqAnswers(a=>({...a,[qi]:letter}))} style={{padding:'9px 14px',borderRadius:DS.radius.sm,border:`1.5px solid ${border}`,background:bg,color,textAlign:'left',cursor:selected?'default':'pointer',fontWeight:(isSelected||isCorrect&&revealed)?700:400,fontSize:13,transition:DS.tr}}>
                            {opt}{revealed&&isCorrect?<Check size={12} strokeWidth={2.5} style={{display:'inline',verticalAlign:'middle',marginLeft:3}}/>:revealed&&isSelected?<X size={12} strokeWidth={2.5} style={{display:'inline',verticalAlign:'middle',marginLeft:3}}/>:''}
                          </button>
                        );
                      })}
                    </div>
                    {selected&&<div style={{marginTop:12,background:DS.bg.surface,borderLeft:`3px solid ${selected===q.answer?DS.accent.teal:DS.accent.amber}`,padding:'10px 14px',borderRadius:`0 ${DS.radius.sm}px ${DS.radius.sm}px 0`}}>
                      <div style={{fontSize:10,fontWeight:800,color:selected===q.answer?DS.accent.teal:DS.accent.amber,marginBottom:4,display:'flex',alignItems:'center',gap:3}}>{selected===q.answer?<><Check size={11} strokeWidth={2.5}/>CORRECT</>:<><X size={11} strokeWidth={2.5}/>NOT QUITE — EXPLANATION</>}</div>
                      <p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{q.explanation}</p>
                    </div>}
                  </div>
                );
              })}
              {mcqData&&<button onClick={()=>{setMcqData(null);setMcqAnswers({});}} style={{width:'100%',padding:10,borderRadius:DS.radius.sm,border:`1px solid ${DS.border}`,background:DS.bg.surface,color:DS.text.secondary,fontSize:12,cursor:'pointer',fontWeight:700,marginTop:4}}>🔄 New Questions</button>}
            </div>
          )}

          {/* Worked Steps */}
          {learnMode==='steps'&&(
            <div>
              {!stepsData&&!stepsLoading&&(
                <div style={{textAlign:'center',padding:32}}>
                  <div style={{fontSize:32,marginBottom:12}}>🪜</div>
                  <p style={{fontSize:14,color:DS.text.secondary,marginBottom:20}}>Watch a full solution broken into clear steps — reveal them one at a time</p>
                  <button onClick={handleLoadSteps} disabled={!hasKey} style={{padding:'10px 28px',borderRadius:DS.radius.md,border:'none',background:DS.accent.amber,color:DS.bg.base,fontWeight:800,fontSize:13,cursor:hasKey?'pointer':'not-allowed',opacity:hasKey?1:0.5}}>Generate Worked Example</button>
                  {!hasKey&&<div style={{marginTop:8,fontSize:11,color:DS.text.muted}}>Requires VITE_ANTHROPIC_API_KEY</div>}
                </div>
              )}
              {stepsLoading&&<div style={{textAlign:'center',padding:40,color:DS.text.secondary}}><Loader2 size={32} strokeWidth={2} style={{animation:'spin 0.8s linear infinite',color:DS.accent.amber,margin:'0 auto 12px',display:'block'}}/>Building worked example…</div>}
              {stepsData&&!stepsData.error&&(
                <div>
                  <div style={{background:DS.bg.elevated,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:18,marginBottom:14}}>
                    <div style={{fontSize:10,fontWeight:800,color:DS.accent.amber,textTransform:'uppercase',letterSpacing:1.5,marginBottom:8}}>The Problem</div>
                    <p style={{margin:0,fontSize:14,lineHeight:1.65,color:DS.text.primary}}>{stepsData.problem}</p>
                  </div>
                  {stepsData.steps?.slice(0,stepsRevealed).map((s,i)=>(
                    <div key={i} style={{background:DS.bg.elevated,borderLeft:`3px solid ${DS.accent.teal}`,borderRadius:DS.radius.md,padding:16,marginBottom:10,animation:'fadeIn 0.3s ease',border:`1px solid ${DS.border}`}}>
                      <div style={{fontSize:10,fontWeight:800,color:DS.accent.teal,marginBottom:8}}>STEP {s.number}</div>
                      <div style={{fontSize:13,fontWeight:700,color:DS.text.primary,marginBottom:4}}>{s.what}</div>
                      <div style={{fontSize:12,color:DS.text.secondary,marginBottom:8,fontStyle:'italic'}}>{s.why}</div>
                      <div style={{background:DS.bg.surface,borderRadius:DS.radius.sm,padding:'8px 12px',fontFamily:'monospace',fontSize:13,color:DS.accent.amber}}>→ {s.result}</div>
                    </div>
                  ))}
                  {stepsRevealed<(stepsData.steps?.length||0)&&(
                    <button onClick={()=>setStepsRevealed(r=>r+1)} style={{width:'100%',padding:12,borderRadius:DS.radius.md,border:`1.5px dashed ${DS.accent.teal}`,background:DS.accent.tealDim,color:DS.accent.teal,fontWeight:800,fontSize:13,cursor:'pointer',transition:DS.tr}}>
                      Reveal Step {stepsRevealed+1} of {stepsData.steps?.length} →
                    </button>
                  )}
                  {stepsRevealed>0&&stepsRevealed>=(stepsData.steps?.length||0)&&(
                    <div style={{textAlign:'center',padding:16,color:DS.accent.teal,fontWeight:800,fontSize:14}}>🎉 Full solution revealed!</div>
                  )}
                  <button onClick={()=>{setStepsData(null);setStepsRevealed(0);}} style={{width:'100%',padding:9,borderRadius:DS.radius.sm,border:`1px solid ${DS.border}`,background:DS.bg.surface,color:DS.text.secondary,fontSize:12,cursor:'pointer',fontWeight:700,marginTop:8}}>🔄 New Example</button>
                </div>
              )}
              {stepsData?.error&&<div style={{background:DS.accent.redDim,borderRadius:DS.radius.sm,padding:'10px 14px',color:DS.accent.red,fontSize:12,border:`1px solid ${DS.accent.red}33`}}>{stepsData.error}</div>}
            </div>
          )}

          {/* Explain It Back */}
          {learnMode==='explain'&&(
            <div>
              <div style={{background:DS.bg.elevated,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:18,marginBottom:16}}>
                <div style={{fontSize:12,fontWeight:800,color:DS.text.primary,marginBottom:8}}>💬 Teach it back</div>
                <p style={{margin:'0 0 14px',fontSize:13,color:DS.text.secondary,lineHeight:1.6}}>Imagine you're explaining <strong style={{color:DS.text.primary}}>{topic.title}</strong> to a friend. Write as much as you can — the AI will check what you know and what to add.</p>
                <textarea value={explainText} onChange={e=>setExplainText(e.target.value)} placeholder={`In my own words, ${topic.title} is about...`} style={{width:'100%',minHeight:100,padding:12,borderRadius:DS.radius.sm,border:`1.5px solid ${DS.border}`,fontSize:13,fontFamily:'inherit',resize:'vertical',boxSizing:'border-box',outline:'none',background:DS.bg.surface,color:DS.text.primary}} onFocus={e=>e.target.style.borderColor=DS.accent.teal} onBlur={e=>e.target.style.borderColor=DS.border}/>
                <button onClick={handleExplainSubmit} disabled={explainLoading||!explainText.trim()||!hasKey} style={{marginTop:10,width:'100%',padding:11,borderRadius:DS.radius.sm,border:'none',background:explainLoading||!explainText.trim()||!hasKey?DS.bg.overlay:DS.accent.teal,color:explainLoading||!explainText.trim()||!hasKey?DS.text.muted:DS.bg.base,fontWeight:800,fontSize:13,cursor:explainLoading||!explainText.trim()||!hasKey?'not-allowed':'pointer',transition:DS.tr}}>
                  {explainLoading?'Checking your understanding…':<><Check size={13} strokeWidth={2.5} style={{display:'inline',verticalAlign:'middle',marginRight:4}}/> Check My Understanding</>}
                </button>
                {!hasKey&&<div style={{textAlign:'center',fontSize:11,color:DS.text.muted,marginTop:6}}>Requires VITE_ANTHROPIC_API_KEY</div>}
              </div>
              {explainResult&&!explainResult.error&&(
                <div style={{background:DS.bg.elevated,border:`1.5px solid ${DS.borderHi}`,borderRadius:DS.radius.md,padding:18}}>
                  <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:16}}>
                    <div style={{width:56,height:56,borderRadius:'50%',background:explainResult.score>=4?DS.accent.tealDim:explainResult.score>=2?DS.accent.amberDim:DS.accent.redDim,border:`2.5px solid ${explainResult.score>=4?DS.accent.teal:explainResult.score>=2?DS.accent.amber:DS.accent.red}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                      <span style={{fontSize:18,fontWeight:900,color:explainResult.score>=4?DS.accent.teal:explainResult.score>=2?DS.accent.amber:DS.accent.red}}>{explainResult.score}/5</span>
                    </div>
                    <p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.5,fontStyle:'italic'}}>{explainResult.encouragement}</p>
                  </div>
                  {explainResult.correct&&<div style={{borderLeft:`3px solid ${DS.accent.teal}`,paddingLeft:10,marginBottom:10}}><div style={{fontSize:9,fontWeight:800,color:DS.accent.teal,marginBottom:3}}>WHAT YOU GOT RIGHT</div><p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{explainResult.correct}</p></div>}
                  {explainResult.missing&&<div style={{borderLeft:`3px solid ${DS.accent.amber}`,paddingLeft:10,marginBottom:10}}><div style={{fontSize:9,fontWeight:800,color:DS.accent.amber,marginBottom:3}}>KEY CONCEPTS TO ADD</div><p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{explainResult.missing}</p></div>}
                  {explainResult.tip&&<div style={{background:DS.bg.surface,borderRadius:DS.radius.sm,padding:'10px 14px'}}><div style={{fontSize:9,fontWeight:800,color:DS.text.muted,marginBottom:3,display:'flex',alignItems:'center',gap:3}}><Lightbulb size={10} strokeWidth={2}/>TIP FOR NEXT TIME</div><p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{explainResult.tip}</p></div>}
                  <button onClick={()=>{setExplainText('');setExplainResult(null);}} style={{marginTop:14,width:'100%',padding:9,borderRadius:DS.radius.sm,border:`1px solid ${DS.border}`,background:'transparent',color:DS.text.muted,fontSize:12,cursor:'pointer',fontWeight:700}}>Try Again</button>
                </div>
              )}
              {explainResult?.error&&<div style={{background:DS.accent.redDim,borderRadius:DS.radius.sm,padding:'10px 14px',color:DS.accent.red,fontSize:12,border:`1px solid ${DS.accent.red}33`}}>{explainResult.error}</div>}
            </div>
          )}

          {/* Visual Diagram */}
          {learnMode==='visual'&&(
            <div>
              {!vizData&&!vizLoading&&(
                <div style={{textAlign:'center',padding:32}}>
                  <div style={{fontSize:32,marginBottom:12}}>🎨</div>
                  <p style={{fontSize:14,color:DS.text.secondary,marginBottom:8}}>AI generates a custom diagram — a number line, flowchart, formula breakdown, comparison grid — whatever best visualises this concept</p>
                  <p style={{fontSize:12,color:DS.text.muted,marginBottom:20}}>Different every time you generate</p>
                  <button onClick={handleLoadViz} disabled={!hasKey} style={{padding:'10px 28px',borderRadius:DS.radius.md,border:'none',background:DS.accent.amber,color:DS.bg.base,fontWeight:800,fontSize:13,cursor:hasKey?'pointer':'not-allowed',opacity:hasKey?1:0.5}}>Generate Visual</button>
                  {!hasKey&&<div style={{marginTop:8,fontSize:11,color:DS.text.muted}}>Requires VITE_ANTHROPIC_API_KEY</div>}
                </div>
              )}
              {vizLoading&&<div style={{textAlign:'center',padding:40,color:DS.text.secondary}}><Loader2 size={32} strokeWidth={2} style={{animation:'spin 0.8s linear infinite',color:DS.accent.amber,margin:'0 auto 12px',display:'block'}}/>Drawing diagram…</div>}
              {vizData&&!vizData.error&&(
                <div>
                  <div style={{background:DS.bg.elevated,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:20,marginBottom:14}}>
                    <div style={{fontSize:11,fontWeight:800,color:DS.accent.amber,textTransform:'uppercase',letterSpacing:1.5,marginBottom:16}}>{vizData.title}</div>
                    <pre style={{margin:0,fontFamily:'monospace',fontSize:13,lineHeight:1.7,color:DS.accent.teal,overflowX:'auto',whiteSpace:'pre',background:DS.bg.surface,padding:16,borderRadius:DS.radius.sm,border:`1px solid ${DS.border}`}}>{vizData.diagram}</pre>
                  </div>
                  {vizData.callouts?.length>0&&(
                    <div style={{background:DS.bg.elevated,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:16,marginBottom:14}}>
                      <div style={{fontSize:10,fontWeight:800,color:DS.text.muted,textTransform:'uppercase',letterSpacing:1.5,marginBottom:10}}>Key Points to Notice</div>
                      {vizData.callouts.map((c,i)=>(
                        <div key={i} style={{display:'flex',gap:10,marginBottom:8}}>
                          <div style={{width:20,height:20,borderRadius:'50%',background:DS.accent.amberDim,color:DS.accent.amber,border:`1px solid ${DS.accent.amber}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:800,flexShrink:0}}>{i+1}</div>
                          <p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.6}}>{c}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {vizData.insight&&<div style={{background:DS.accent.amberDim,border:`1px solid ${DS.accent.amber}33`,borderRadius:DS.radius.md,padding:'12px 16px'}}><span style={{fontSize:10,fontWeight:800,color:DS.accent.amber,display:'inline-flex',alignItems:'center',gap:3}}><Lightbulb size={10} strokeWidth={2}/>KEY INSIGHT  </span><span style={{fontSize:13,color:DS.text.secondary}}>{vizData.insight}</span></div>}
                  <button onClick={()=>setVizData(null)} style={{width:'100%',padding:9,borderRadius:DS.radius.sm,border:`1px solid ${DS.border}`,background:DS.bg.surface,color:DS.text.secondary,fontSize:12,cursor:'pointer',fontWeight:700,marginTop:12}}>🔄 Generate Different Visual</button>
                </div>
              )}
              {vizData?.error&&<div style={{background:DS.accent.redDim,borderRadius:DS.radius.sm,padding:'10px 14px',color:DS.accent.red,fontSize:12,border:`1px solid ${DS.accent.red}33`}}>{vizData.error}</div>}
            </div>
          )}

          {/* Error Hunt */}
          {learnMode==='errors'&&(
            <div>
              {!errorHuntData&&!errorHuntLoading&&(
                <div style={{textAlign:'center',padding:32}}>
                  <div style={{fontSize:32,marginBottom:12}}>🕵️</div>
                  <p style={{fontSize:14,color:DS.text.secondary,marginBottom:8}}>AI writes a worked solution with <strong style={{color:DS.text.primary}}>2 deliberate mistakes</strong> hidden inside</p>
                  <p style={{fontSize:12,color:DS.text.muted,marginBottom:20}}>Read each step carefully. Click the ones you think are wrong, then reveal to check</p>
                  <button onClick={handleLoadErrorHunt} disabled={!hasKey} style={{padding:'10px 28px',borderRadius:DS.radius.md,border:'none',background:'#9B59B6',color:'#fff',fontWeight:800,fontSize:13,cursor:hasKey?'pointer':'not-allowed',opacity:hasKey?1:0.5}}>Generate Error Hunt</button>
                  {!hasKey&&<div style={{marginTop:8,fontSize:11,color:DS.text.muted}}>Requires VITE_ANTHROPIC_API_KEY</div>}
                </div>
              )}
              {errorHuntLoading&&<div style={{textAlign:'center',padding:40,color:DS.text.secondary}}><Loader2 size={32} strokeWidth={2} style={{animation:'spin 0.8s linear infinite',color:'#9B59B6',margin:'0 auto 12px',display:'block'}}/>Planting mistakes…</div>}
              {errorHuntData&&!errorHuntData.error&&(()=>{
                const errorSteps=new Set((errorHuntData.errors||[]).map(e=>e.stepNum));
                return(
                  <div>
                    <div style={{background:DS.bg.elevated,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:18,marginBottom:14}}>
                      <div style={{fontSize:10,fontWeight:800,color:'#9B59B6',textTransform:'uppercase',letterSpacing:1.5,marginBottom:8}}>The Problem</div>
                      <p style={{margin:0,fontSize:14,lineHeight:1.65,color:DS.text.primary}}>{errorHuntData.question}</p>
                    </div>
                    {!errorHuntRevealed&&<div style={{fontSize:12,color:DS.text.muted,marginBottom:10,textAlign:'center'}}>👇 Click any steps you think contain a mistake ({errorHuntSelected.size} selected)</div>}
                    {errorHuntData.steps?.map(s=>{
                      const isSelected=errorHuntSelected.has(s.n);
                      const isActuallyWrong=errorSteps.has(s.n);
                      let bg=DS.bg.elevated,border=DS.border,color=DS.text.primary;
                      if(errorHuntRevealed){
                        if(isActuallyWrong){bg='rgba(155,89,182,0.12)';border='#9B59B6';color=DS.text.primary;}
                        else{bg=DS.bg.elevated;border=DS.accent.teal+'44';}
                      } else if(isSelected){bg='rgba(155,89,182,0.12)';border='#9B59B6';}
                      return(
                        <div key={s.n} onClick={()=>{if(errorHuntRevealed)return;setErrorHuntSelected(prev=>{const n=new Set(prev);n.has(s.n)?n.delete(s.n):n.add(s.n);return n;});}} style={{background:bg,border:`1.5px solid ${border}`,borderRadius:DS.radius.md,padding:'12px 16px',marginBottom:8,cursor:errorHuntRevealed?'default':'pointer',transition:DS.tr,display:'flex',gap:12,alignItems:'flex-start'}}>
                          <div style={{minWidth:24,height:24,borderRadius:'50%',background:errorHuntRevealed&&isActuallyWrong?'rgba(155,89,182,0.2)':isSelected&&!errorHuntRevealed?'rgba(155,89,182,0.2)':DS.bg.surface,border:`1.5px solid ${errorHuntRevealed&&isActuallyWrong?'#9B59B6':isSelected&&!errorHuntRevealed?'#9B59B6':DS.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:800,color:errorHuntRevealed&&isActuallyWrong?'#9B59B6':isSelected?'#9B59B6':DS.text.muted,flexShrink:0}}>{s.n}</div>
                          <div style={{flex:1}}>
                            <p style={{margin:0,fontSize:13,lineHeight:1.6,color,fontFamily:'monospace'}}>{s.text}</p>
                            {errorHuntRevealed&&isActuallyWrong&&(errorHuntData.errors||[]).filter(e=>e.stepNum===s.n).map((e,i)=>(
                              <div key={i} style={{marginTop:10,background:DS.bg.surface,borderRadius:DS.radius.sm,padding:'10px 14px',borderLeft:`3px solid #9B59B6`}}>
                                <div style={{fontSize:9,fontWeight:800,color:'#9B59B6',marginBottom:4}}>MISTAKE FOUND</div>
                                <p style={{margin:'0 0 6px',fontSize:12,color:DS.accent.red,lineHeight:1.5}}>{e.error}</p>
                                <div style={{fontSize:9,fontWeight:800,color:DS.accent.teal,marginBottom:3}}>CORRECTION</div>
                                <p style={{margin:0,fontSize:12,color:DS.accent.teal,lineHeight:1.5}}>{e.correction}</p>
                              </div>
                            ))}
                            {errorHuntRevealed&&!isActuallyWrong&&<div style={{marginTop:6,fontSize:11,color:DS.accent.teal,fontWeight:700,display:'flex',alignItems:'center',gap:3}}><Check size={12} strokeWidth={2.5}/>This step is correct</div>}
                          </div>
                          {!errorHuntRevealed&&<div style={{fontSize:16,flexShrink:0,opacity:isSelected?1:0.3}}>{isSelected?'🔴':'⚪'}</div>}
                        </div>
                      );
                    })}
                    {!errorHuntRevealed&&(
                      <button onClick={()=>setErrorHuntRevealed(true)} style={{width:'100%',padding:12,borderRadius:DS.radius.md,border:'none',background:'#9B59B6',color:'#fff',fontWeight:800,fontSize:13,cursor:'pointer',marginTop:8,transition:DS.tr}}>
                        Reveal Mistakes →
                      </button>
                    )}
                    {errorHuntRevealed&&(
                      <div>
                        {errorHuntData.tip&&<div style={{background:'rgba(155,89,182,0.08)',border:'1px solid rgba(155,89,182,0.25)',borderRadius:DS.radius.md,padding:'12px 16px',marginTop:12}}><div style={{fontSize:10,fontWeight:800,color:'#9B59B6',marginBottom:4,display:'flex',alignItems:'center',gap:3}}><Lightbulb size={10} strokeWidth={2}/>EXAMINER TIP</div><p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{errorHuntData.tip}</p></div>}
                        <button onClick={()=>{setErrorHuntData(null);setErrorHuntSelected(new Set());setErrorHuntRevealed(false);}} style={{width:'100%',padding:9,borderRadius:DS.radius.sm,border:`1px solid ${DS.border}`,background:DS.bg.surface,color:DS.text.secondary,fontSize:12,cursor:'pointer',fontWeight:700,marginTop:10}}>🔄 New Error Hunt</button>
                      </div>
                    )}
                  </div>
                );
              })()}
              {errorHuntData?.error&&<div style={{background:DS.accent.redDim,borderRadius:DS.radius.sm,padding:'10px 14px',color:DS.accent.red,fontSize:12,border:`1px solid ${DS.accent.red}33`}}>{errorHuntData.error}</div>}
            </div>
          )}

          {/* Real World Story */}
          {learnMode==='story'&&(
            <div>
              {!realWorldData&&!realWorldLoading&&(
                <div style={{textAlign:'center',padding:32}}>
                  <div style={{fontSize:32,marginBottom:12}}>🌍</div>
                  <p style={{fontSize:14,color:DS.text.secondary,marginBottom:8}}>AI creates an unexpected real-world scenario — gaming, music, sports, architecture — where this exact maths becomes essential</p>
                  <p style={{fontSize:12,color:DS.text.muted,marginBottom:20}}>Different context every time</p>
                  <button onClick={handleLoadRealWorld} disabled={!hasKey} style={{padding:'10px 28px',borderRadius:DS.radius.md,border:'none',background:DS.accent.teal,color:DS.bg.base,fontWeight:800,fontSize:13,cursor:hasKey?'pointer':'not-allowed',opacity:hasKey?1:0.5}}>Generate Story</button>
                  {!hasKey&&<div style={{marginTop:8,fontSize:11,color:DS.text.muted}}>Requires VITE_ANTHROPIC_API_KEY</div>}
                </div>
              )}
              {realWorldLoading&&<div style={{textAlign:'center',padding:40,color:DS.text.secondary}}><Loader2 size={32} strokeWidth={2} style={{animation:'spin 0.8s linear infinite',color:DS.accent.teal,margin:'0 auto 12px',display:'block'}}/>Building scenario…</div>}
              {realWorldData&&!realWorldData.error&&(
                <div>
                  <div style={{background:DS.bg.elevated,border:`1.5px solid ${DS.accent.teal}44`,borderRadius:DS.radius.lg,padding:20,marginBottom:14}}>
                    <div style={{fontSize:16,fontWeight:800,color:DS.text.primary,marginBottom:12,lineHeight:1.4}}>{realWorldData.hook}</div>
                    <p style={{margin:'0 0 16px',fontSize:13,color:DS.text.secondary,lineHeight:1.75}}>{realWorldData.context}</p>
                    <div style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:14}}>
                      <div style={{fontSize:10,fontWeight:800,color:DS.accent.amber,marginBottom:8,textTransform:'uppercase',letterSpacing:1.5}}>The Question</div>
                      <p style={{margin:0,fontSize:14,color:DS.text.primary,lineHeight:1.65,fontWeight:600}}>{realWorldData.question}</p>
                    </div>
                  </div>
                  {!realWorldSolutionShown?(
                    <button onClick={()=>setRealWorldSolutionShown(true)} style={{width:'100%',padding:12,borderRadius:DS.radius.md,border:`1.5px dashed ${DS.accent.teal}`,background:DS.accent.tealDim,color:DS.accent.teal,fontWeight:800,fontSize:13,cursor:'pointer',transition:DS.tr}}>Have a go, then reveal the solution →</button>
                  ):(
                    <div>
                      <div style={{background:DS.bg.elevated,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:18,marginBottom:12}}>
                        <div style={{fontSize:10,fontWeight:800,color:DS.accent.teal,textTransform:'uppercase',letterSpacing:1.5,marginBottom:10}}>Solution</div>
                        <p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.85,whiteSpace:'pre-line'}}>{realWorldData.solution}</p>
                      </div>
                      {realWorldData.connection&&<div style={{background:DS.accent.amberDim,border:`1px solid ${DS.accent.amber}33`,borderRadius:DS.radius.md,padding:'12px 16px',marginBottom:12}}><span style={{fontSize:10,fontWeight:800,color:DS.accent.amber}}>🔗 GCSE LINK  </span><span style={{fontSize:13,color:DS.text.secondary}}>{realWorldData.connection}</span></div>}
                      <button onClick={()=>{setRealWorldData(null);setRealWorldSolutionShown(false);}} style={{width:'100%',padding:9,borderRadius:DS.radius.sm,border:`1px solid ${DS.border}`,background:DS.bg.surface,color:DS.text.secondary,fontSize:12,cursor:'pointer',fontWeight:700}}>🔄 New Scenario</button>
                    </div>
                  )}
                </div>
              )}
              {realWorldData?.error&&<div style={{background:DS.accent.redDim,borderRadius:DS.radius.sm,padding:'10px 14px',color:DS.accent.red,fontSize:12,border:`1px solid ${DS.accent.red}33`}}>{realWorldData.error}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══ FOCUS TODAY (DUE FOR REVIEW) + REVIEW CALENDAR ═════════════════════════
function DueForReview({onNavigate}){
  const [showCalendar,setShowCalendar]=useState(false);
  const srData=lsGet('gcse_sr',{});
  const now=new Date();
  const dayStart=(d)=>{const x=new Date(d);x.setHours(0,0,0,0);return x;};
  const today=dayStart(now);
  const tomorrow=new Date(today);tomorrow.setDate(today.getDate()+1);
  const in7=new Date(today);in7.setDate(today.getDate()+7);

  const dueIds=getDueIds();
  const dueQs=dueIds.map(id=>QUESTION_MAP[id]).filter(Boolean);
  const urgent=dueQs.length>3;

  // Build upcoming schedule
  const upcoming=Object.entries(srData)
    .filter(([,v])=>v.nextReview&&new Date(v.nextReview)>today&&new Date(v.nextReview)<=in7)
    .map(([id,v])=>({q:QUESTION_MAP[id],nextReview:new Date(v.nextReview)}))
    .filter(x=>x.q)
    .sort((a,b)=>a.nextReview-b.nextReview);
  const tomorrowQs=upcoming.filter(x=>dayStart(x.nextReview).getTime()===tomorrow.getTime());
  const laterQs=upcoming.filter(x=>dayStart(x.nextReview).getTime()>tomorrow.getTime());

  return(
    <div style={{marginBottom:16}}>
      {dueQs.length===0?(
        <div style={{background:DS.bg.surface,borderLeft:`3px solid ${DS.accent.teal}`,borderRadius:DS.radius.md,padding:'12px 18px',border:`1px solid ${DS.border}`}}>
          <div style={{fontSize:12,fontWeight:800,color:DS.accent.teal,display:'flex',alignItems:'center',gap:4}}><Check size={14} strokeWidth={2.5}/> All caught up — no reviews due today</div>
        </div>
      ):(
        <div style={{background:DS.bg.surface,borderLeft:`3px solid ${DS.accent.amber}`,borderRadius:DS.radius.md,padding:'14px 18px',border:`1px solid ${DS.border}`,animation:urgent?'pulseAmber 2s ease-in-out infinite':undefined}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
            <div style={{fontSize:12,fontWeight:800,color:DS.accent.amber}}>Review Due — {dueQs.length} question{dueQs.length!==1?'s':''}</div>
            <div style={{fontSize:10,color:DS.text.muted}}>Spaced repetition</div>
          </div>
          <div style={{display:'grid',gap:7}}>
            {dueQs.slice(0,5).map(q=>(
              <div key={q.qid} style={{background:DS.bg.elevated,borderRadius:DS.radius.sm,padding:'10px 12px',display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,border:`1px solid ${DS.border}`}}>
                <div style={{overflow:'hidden'}}>
                  <div style={{fontSize:12,fontWeight:700,color:DS.text.primary,marginBottom:1}}>{q.topicTitle}</div>
                  <div style={{fontSize:11,color:DS.text.muted,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:220}}>{q.q?.slice(0,55)}…</div>
                </div>
                <button onClick={()=>onNavigate(q.topicId)} style={{padding:'5px 10px',borderRadius:DS.radius.sm,border:`1px solid ${DS.accent.amber}`,background:DS.accent.amberDim,color:DS.accent.amber,fontWeight:800,fontSize:11,cursor:'pointer',flexShrink:0,transition:DS.tr}}>Review →</button>
              </div>
            ))}
            {dueQs.length>5&&<div style={{fontSize:11,color:DS.text.muted,textAlign:'center'}}>+{dueQs.length-5} more due today</div>}
          </div>
        </div>
      )}

      {/* Review Calendar */}
      {upcoming.length>0&&(
        <div style={{marginTop:8}}>
          <button onClick={()=>setShowCalendar(s=>!s)} style={{width:'100%',background:'none',border:`1px solid ${DS.border}`,borderRadius:DS.radius.sm,padding:'7px 14px',color:DS.text.muted,fontSize:11,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'space-between',transition:DS.tr}}>
            <span style={{display:'flex',alignItems:'center',gap:6}}><Calendar size={12} strokeWidth={2}/>Upcoming reviews — {upcoming.length} scheduled this week</span>
            <span>{showCalendar?'▲':'▼'}</span>
          </button>
          {showCalendar&&(
            <div style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderTop:'none',borderRadius:`0 0 ${DS.radius.sm} ${DS.radius.sm}`,padding:'10px 14px',display:'grid',gap:6}}>
              {tomorrowQs.length>0&&<div style={{fontSize:10,fontWeight:800,color:DS.accent.amber,textTransform:'uppercase',letterSpacing:1,marginBottom:2}}>Tomorrow — {tomorrowQs.length} due</div>}
              {tomorrowQs.slice(0,3).map(({q},i)=><div key={i} style={{fontSize:11,color:DS.text.secondary,padding:'4px 0',borderBottom:`1px solid ${DS.border}`}}>{q.topicTitle}: <span style={{color:DS.text.muted}}>{q.q?.slice(0,40)}…</span></div>)}
              {laterQs.length>0&&<div style={{fontSize:10,fontWeight:800,color:DS.text.muted,textTransform:'uppercase',letterSpacing:1,marginTop:6,marginBottom:2}}>Later this week — {laterQs.length} due</div>}
              {laterQs.slice(0,3).map(({q,nextReview},i)=><div key={i} style={{fontSize:11,color:DS.text.secondary,padding:'4px 0',borderBottom:`1px solid ${DS.border}`}}><span style={{color:DS.accent.teal,fontWeight:700}}>{nextReview.toLocaleDateString('en-GB',{weekday:'short'})}</span> · {q.topicTitle}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══ WEAKNESS HEATMAP ════════════════════════════════════════════════════════
function WeaknessHeatmap({onNavigate,collapsible=false}){
  const [open,setOpen]=useState(!collapsible);
  const perf=lsGet('gcse_perf',{});
  const allTopics=MODULES.flatMap(m=>m.topics.map(t=>({...t,moduleLabel:m.label,moduleColor:m.color})));
  return(
    <div style={{background:DS.bg.surface,borderRadius:DS.radius.md,border:`1px solid ${DS.border}`,marginBottom:16,overflow:'hidden'}}>
      <button onClick={()=>collapsible&&setOpen(o=>!o)} style={{width:'100%',display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 18px',background:'none',border:'none',cursor:collapsible?'pointer':'default',textAlign:'left'}}>
        <div style={{fontSize:10,fontWeight:800,color:DS.text.secondary,textTransform:'uppercase',letterSpacing:1.5}}>Performance Breakdown</div>
        {collapsible&&<span style={{fontSize:11,color:DS.text.muted,fontWeight:700}}>{open?'▲ Hide':'▼ Show'}</span>}
      </button>
      {open&&<div style={{padding:'0 18px 16px'}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))',gap:6}}>
        {allTopics.map(t=>{
          const p=perf[t.id];
          const ratio=p&&p.total>0?p.correct/p.total:null;
          const hc=heatColor(ratio);
          return(
            <button key={t.id} onClick={()=>onNavigate(t.id)} style={{background:DS.bg.elevated,border:`1px solid ${DS.border}`,borderRadius:DS.radius.sm,padding:'8px 10px',textAlign:'left',cursor:'pointer',transition:DS.tr}} onMouseEnter={e=>e.currentTarget.style.borderColor=hc.c} onMouseLeave={e=>e.currentTarget.style.borderColor=DS.border}>
              <div style={{fontSize:9,fontWeight:800,color:hc.c,textTransform:'uppercase',marginBottom:2}}>{t.moduleLabel}</div>
              <div style={{fontSize:11,fontWeight:700,color:DS.text.primary,lineHeight:1.3,marginBottom:3}}>{t.title}</div>
              <div style={{fontSize:10,color:hc.c,fontWeight:600}}>{ratio!==null?`${Math.round(ratio*100)}% (${p.correct}/${p.total})`:'Not attempted'}</div>
            </button>
          );
        })}
      </div>
      <div style={{display:'flex',gap:14,marginTop:10,flexWrap:'wrap'}}>
        {[{c:DS.accent.teal,l:'Strong ≥70%'},{c:DS.accent.amber,l:'Improving 40–69%'},{c:DS.accent.red,l:'Needs work <40%'},{c:DS.text.muted,l:'Not attempted'}].map(x=>(
          <div key={x.l} style={{display:'flex',gap:5,alignItems:'center'}}>
            <div style={{width:8,height:8,borderRadius:'50%',background:x.c}}/>
            <span style={{fontSize:10,color:DS.text.muted}}>{x.l}</span>
          </div>
        ))}
      </div>
      </div>}
    </div>
  );
}

// ═══ PLATFORM ════════════════════════════════════════════════════════════════
export function Platform({onXP=()=>{},xpV=0,mode='sprint',onOpenDaily=()=>{}}){
  const [modId,setModId]=useState(null);
  const [topicId,setTopicId]=useState(null);
  const [search,setSearch]=useState("");
  const [version,setVersion]=useState(0);
  const xp=getXP();

  const mod=MODULES.find(m=>m.id===modId);
  const topic=mod?.topics.find(t=>t.id===topicId);
  const totalQ=MODULES.reduce((s,m)=>s+m.topics.reduce((ss,t)=>ss+t.questions.length,0),0);
  const totalT=MODULES.reduce((s,m)=>s+m.topics.length,0);

  const handleAnswered=()=>{
    setVersion(v=>v+1);
    if(topic){
      const flagKey=`lumora_tc_${topic.id}`;
      if(!lsGet(flagKey,false)){
        const srData=lsGet('gcse_sr',{});
        const allAnswered=topic.questions.every((_,i)=>srData[`${topic.id}:${i}`]);
        if(allAnswered){lsSet(flagKey,true);onXP(50);}
      }
    }
  };
  const searchRes=search.trim().length>1?MODULES.flatMap(m=>m.topics.filter(t=>t.title.toLowerCase().includes(search.toLowerCase())).map(t=>({...t,mod:m}))):[];

  const navigateToTopic=(tid)=>{
    const m=findModForTopic(tid);
    if(m){setModId(m.id);setTopicId(tid);track('topic_opened',{topicId:tid,moduleId:m.id});}
  };

  if(topic)return(
    <div style={{fontFamily:"'Segoe UI',sans-serif",maxWidth:680,margin:"0 auto",padding:16,background:mode==='deep'?DS.bg.deep:DS.bg.base,minHeight:"100vh"}}>
      <div style={{background:DS.bg.surface,borderRadius:DS.radius.lg,padding:"14px 18px",marginBottom:14,border:`1px solid ${DS.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
          <button onClick={()=>{setModId(null);setTopicId(null);}} style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:DS.text.secondary}}>⌂</button>
          <span style={{color:DS.text.muted}}>›</span>
          <button onClick={()=>setTopicId(null)} style={{background:"none",border:"none",cursor:"pointer",fontSize:12,color:mod.color,fontWeight:700}}>{mod.label}</button>
          <span style={{color:DS.text.muted}}>›</span>
          <span style={{fontSize:12,color:DS.text.secondary,fontWeight:600}}>{topic.title}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:44,height:44,borderRadius:DS.radius.md,background:mod.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,color:"#fff",flexShrink:0}}>{mod.icon}</div>
          <div><div style={{fontSize:17,fontWeight:800,color:DS.text.primary}}>{topic.title}</div><div style={{fontSize:11,color:DS.text.muted,marginTop:2}}>{topic.questions.length} questions · 3 difficulty levels</div></div>
        </div>
      </div>
      <TopicPage topic={topic} moduleColor={mod.color} moduleLabel={mod.label} onAnswered={handleAnswered} onXP={onXP}/>
    </div>
  );

  if(mod)return(
    <div style={{fontFamily:"'Segoe UI',sans-serif",maxWidth:680,margin:"0 auto",padding:16,background:mode==='deep'?DS.bg.deep:DS.bg.base,minHeight:"100vh"}}>
      <div style={{background:DS.bg.elevated,borderRadius:DS.radius.lg,padding:"22px",marginBottom:14,position:"relative",overflow:"hidden",border:`1px solid ${DS.border}`,borderLeft:`4px solid ${mod.color}`}}>
        <div style={{position:"absolute",right:-20,top:-20,fontSize:110,opacity:0.05,fontWeight:900}}>{mod.icon}</div>
        <button onClick={()=>setModId(null)} style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.sm,padding:"5px 12px",color:DS.text.secondary,fontSize:12,fontWeight:700,cursor:"pointer",marginBottom:10}}>← Back</button>
        <div style={{fontSize:22,fontWeight:900,color:DS.text.primary}}>{mod.label}</div>
        <div style={{fontSize:12,color:DS.text.muted,marginTop:4}}>{mod.topics.length} topics</div>
      </div>
      <div style={{display:"grid",gap:8}}>
        {mod.topics.map(t=>(
          <button key={t.id} onClick={()=>setTopicId(t.id)} style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:"16px 18px",textAlign:"left",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",transition:DS.tr}} onMouseEnter={e=>e.currentTarget.style.borderColor=mod.color} onMouseLeave={e=>e.currentTarget.style.borderColor=DS.border}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:4,flexWrap:'wrap'}}>
                <div style={{fontSize:14,fontWeight:700,color:DS.text.primary}}>{t.title}</div>
                {t.boards&&Object.keys(t.boards).length===1&&t.boards['Edexcel IGCSE']&&(
                  <span style={{fontSize:9,fontWeight:800,background:'rgba(123,45,139,0.15)',color:'#C39BD3',border:'1px solid rgba(123,45,139,0.3)',borderRadius:4,padding:'1px 6px',letterSpacing:0.5,whiteSpace:'nowrap'}}>IGCSE ONLY</span>
                )}
              </div>
              <div style={{display:"flex",gap:5,alignItems:"center"}}>
                {t.questions.map((q,i)=><span key={i} style={{width:8,height:8,borderRadius:"50%",background:(DIFF[q.diff]||DIFF.Mid).c,display:"inline-block"}}/>)}
                <span style={{fontSize:10,color:DS.text.muted,marginLeft:4}}>{t.questions.length} questions</span>
              </div>
            </div>
            <span style={{fontSize:20,color:mod.color}}>›</span>
          </button>
        ))}
      </div>
    </div>
  );

  const perf=lsGet('gcse_perf',{});
  return(
    <div style={{fontFamily:"'Segoe UI',sans-serif",maxWidth:680,margin:"0 auto",padding:16,background:mode==='deep'?DS.bg.deep:DS.bg.base,minHeight:"100vh"}}>

      {mode==='deep'&&<div style={{background:DS.bg.surface,borderRadius:DS.radius.md,padding:'10px 16px',marginBottom:14,border:`1px solid ${DS.border}`,display:'flex',alignItems:'center',gap:8}}><Target size={14} color={DS.accent.teal} strokeWidth={2}/><span style={{fontSize:12,fontWeight:700,color:DS.accent.teal}}>Deep Focus — distractions hidden</span></div>}

      {/* Personalised Hero */}
      {mode!=='deep'&&<PersonalisedHero onNavigate={navigateToTopic}/>}

      {/* Daily Challenge widget */}
      {mode!=='deep'&&(()=>{
        const daily=lsGet('lumora_daily',{date:null,completed:false,xp:0});
        const done=daily.date===todayStr()&&daily.completed;
        return done?(
          <div style={{background:DS.bg.surface,border:`1px solid ${DS.accent.teal}33`,borderLeft:`3px solid ${DS.accent.teal}`,borderRadius:DS.radius.md,padding:'12px 16px',marginBottom:14,display:'flex',alignItems:'center',gap:12}}>
            <span style={{fontSize:20}}>✅</span>
            <div style={{flex:1}}>
              <div style={{fontSize:12,fontWeight:800,color:DS.accent.teal}}>Daily Challenge Complete</div>
              <div style={{fontSize:11,color:DS.text.muted,marginTop:2}}>+{daily.xp||0} XP earned today · Come back tomorrow for a new set</div>
            </div>
          </div>
        ):(
          <button onClick={onOpenDaily} style={{width:'100%',background:DS.accent.amberDim,border:`1.5px solid ${DS.accent.amber}44`,borderRadius:DS.radius.md,padding:'13px 16px',marginBottom:14,display:'flex',alignItems:'center',gap:12,cursor:'pointer',textAlign:'left',transition:DS.tr}}>
            <span style={{display:'flex',alignItems:'center'}}><Calendar size={22} strokeWidth={1.5} color={DS.accent.amber}/></span>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:800,color:DS.accent.amber}}>Daily Challenge — not done yet</div>
              <div style={{fontSize:11,color:DS.text.secondary,marginTop:2}}>3 personalised questions · Builds your streak · +XP</div>
            </div>
            <span style={{fontSize:16,color:DS.accent.amber}}>→</span>
          </button>
        );
      })()}

      {/* Gamification bar (sprint mode only) */}
      {mode==='sprint'&&<GamificationBar key={`gam-${xpV}`} xp={xp}/>}


      {/* Search */}
      <div style={{display:'flex',gap:8,marginBottom:14}}>
        <div style={{position:"relative",flex:1}}>
          <span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",fontSize:15,color:DS.text.muted}}>⌕</span>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search topics..." style={{width:"100%",padding:"10px 16px 10px 40px",borderRadius:DS.radius.md,border:`1.5px solid ${DS.border}`,fontSize:14,background:DS.bg.surface,outline:"none",boxSizing:"border-box",color:DS.text.primary}} onFocus={e=>e.target.style.borderColor=DS.accent.amber} onBlur={e=>e.target.style.borderColor=DS.border}/>
        </div>
        <button onClick={()=>{const weak=getWeakTopics();const t=weak[Math.floor(Math.random()*weak.length)];if(t)navigateToTopic(t.id);track('surprise_me_clicked');}} title="Surprise Me — jump to a weak topic" style={{flexShrink:0,padding:'10px 14px',borderRadius:DS.radius.md,border:`1.5px solid ${DS.accent.amber}44`,background:DS.accent.amberDim,color:DS.accent.amber,fontWeight:800,fontSize:12,cursor:'pointer',transition:DS.tr,whiteSpace:'nowrap'}}>
          <Sparkles size={14} strokeWidth={2} style={{display:'inline',verticalAlign:'middle',marginRight:4}}/>Surprise Me
        </button>
      </div>
      {search.trim().length>1&&(
        <div style={{marginBottom:14}}>
          <div style={{fontSize:10,fontWeight:700,color:DS.text.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>{searchRes.length} result{searchRes.length!==1?"s":""}</div>
          {searchRes.map(t=><button key={t.id} onClick={()=>{setModId(t.mod.id);setTopicId(t.id);setSearch("");}} style={{width:"100%",background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:"12px 16px",textAlign:"left",cursor:"pointer",marginBottom:6,display:"flex",alignItems:"center",gap:12,transition:DS.tr}}>
            <div style={{width:32,height:32,borderRadius:DS.radius.sm,background:t.mod.color,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:14,flexShrink:0}}>{t.mod.icon}</div>
            <div><div style={{fontSize:13,fontWeight:700,color:DS.text.primary}}>{t.title}</div><div style={{fontSize:11,color:DS.text.muted}}>{t.mod.label}</div></div>
          </button>)}
        </div>
      )}

      {/* Focus Today */}
      <DueForReview key={`due-${version}`} onNavigate={navigateToTopic}/>

      {/* Weekly Goal */}
      {mode!=='deep'&&<WeeklyGoalBar/>}

      {/* Modules */}
      <div style={{fontSize:10,fontWeight:800,color:DS.text.muted,textTransform:"uppercase",letterSpacing:1.5,marginBottom:10}}>Modules</div>
      <div style={{display:"grid",gap:6,marginBottom:16}}>
        {MODULES.map(m=>{
          const mPerf=m.topics.flatMap(t=>{const p=perf[t.id];return p&&p.total>0?[p.correct/p.total]:[];});
          const ratio=mPerf.length>0?mPerf.reduce((s,v)=>s+v,0)/mPerf.length:0;
          const attempted=mPerf.length;
          const statusColor=attempted===0?DS.text.muted:ratio>=0.7?DS.accent.teal:ratio>=0.4?DS.accent.amber:DS.accent.red;
          return(
            <button key={m.id} onClick={()=>setModId(m.id)} style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:"14px 16px",textAlign:"left",cursor:"pointer",transition:DS.tr,display:"flex",alignItems:"center",gap:14,position:"relative",overflow:"hidden"}} onMouseEnter={e=>e.currentTarget.style.borderColor=m.color} onMouseLeave={e=>e.currentTarget.style.borderColor=DS.border}>
              <div style={{position:"absolute",right:-8,top:-8,fontSize:56,opacity:0.04,lineHeight:1}}>{m.icon}</div>
              <div style={{width:40,height:40,borderRadius:DS.radius.sm,background:m.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:"#fff",flexShrink:0}}>{m.icon}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:14,fontWeight:800,color:DS.text.primary,marginBottom:6}}>{m.label}</div>
                <div style={{height:4,background:DS.bg.elevated,borderRadius:2,overflow:"hidden"}}>
                  <div style={{height:"100%",background:attempted>0?statusColor:DS.border,width:attempted>0?`${Math.round(ratio*100)}%`:"0%",borderRadius:2,transition:"width 0.6s ease"}}/>
                </div>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontSize:13,fontWeight:900,color:statusColor,lineHeight:1}}>{attempted>0?`${Math.round(ratio*100)}%`:"—"}</div>
                <div style={{fontSize:10,color:DS.text.muted,marginTop:3}}>{m.topics.length} topics</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Performance breakdown (collapsed by default) */}
      {mode!=='deep'&&<WeaknessHeatmap key={`heat-${version}`} onNavigate={navigateToTopic} collapsible/>}
    </div>
  );
}

// ═══ MOCK EXAM ════════════════════════════════════════════════════════════════
function MockQCard({q,idx,working,selfMark,onSelfMark}){
  const [showMS,setShowMS]=useState(false);
  const [aiResult,setAiResult]=useState(null);
  const [aiLoading,setAiLoading]=useState(false);
  const d=DIFF[q.diff]||DIFF.Mid;

  const handleAI=async()=>{
    setAiLoading(true);setAiResult(null);
    track('ai_marking_used',{context:'mock_exam',marks:q.marks});
    try{const r=await aiMark(q.q,q.marks,q.ms,working);setAiResult(r);}
    catch(e){setAiResult({error:e.message});}
    setAiLoading(false);
  };

  const markBorderColor=selfMark!=null?selfMark>0?DS.accent.teal:DS.accent.red:DS.border;
  return(
    <div style={{background:DS.bg.surface,border:`1.5px solid ${markBorderColor}`,borderRadius:DS.radius.md,marginBottom:10,overflow:'hidden',transition:DS.tr}}>
      <div style={{padding:'14px 18px'}}>
        <div style={{display:'flex',gap:8,marginBottom:8,alignItems:'center',flexWrap:'wrap'}}>
          <span style={{width:24,height:24,borderRadius:'50%',background:DS.bg.elevated,color:DS.accent.amber,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:11,flexShrink:0}}>{idx+1}</span>
          <span style={{background:d.bg,color:d.c,fontSize:11,fontWeight:800,padding:'2px 8px',borderRadius:6}}>{q.diff}</span>
          <span style={{fontSize:11,color:DS.text.muted,fontWeight:600}}>[{q.marks} marks]</span>
          <span style={{fontSize:10,color:DS.text.muted}}>{q.topicTitle}</span>
          {selfMark!=null&&<span style={{fontSize:12,fontWeight:800,color:selfMark>0?DS.accent.teal:DS.accent.red,marginLeft:'auto'}}>{selfMark}/{q.marks}</span>}
        </div>
        <p style={{margin:0,fontSize:14,lineHeight:1.65,color:DS.text.primary,whiteSpace:'pre-line'}}>{q.q}</p>
        {working&&<div style={{marginTop:10,background:DS.bg.elevated,borderRadius:DS.radius.sm,padding:'10px 12px',border:`1px solid ${DS.border}`}}>
          <div style={{fontSize:9,fontWeight:700,color:DS.text.muted,marginBottom:4,textTransform:'uppercase'}}>Your Working</div>
          <div style={{fontSize:13,color:DS.text.secondary,whiteSpace:'pre-wrap',fontFamily:'monospace'}}>{working}</div>
        </div>}
      </div>
      {showMS&&(
        <div style={{borderTop:`1px solid ${DS.border}`,background:DS.bg.elevated,padding:'14px 18px'}}>
          <div style={{fontSize:10,fontWeight:800,color:DS.accent.teal,textTransform:'uppercase',letterSpacing:1.5,marginBottom:8,borderLeft:`3px solid ${DS.accent.teal}`,paddingLeft:8}}>Mark Scheme</div>
          {q.ms.map((m,i)=><div key={i} style={{fontSize:13,color:DS.text.primary,padding:'3px 0',display:'flex',gap:8}}><span style={{color:DS.accent.teal,fontWeight:700}}>›</span>{m}</div>)}
          {q.insight&&<div style={{background:DS.bg.surface,borderLeft:`3px solid ${DS.accent.teal}`,borderRadius:`0 ${DS.radius.sm}px ${DS.radius.sm}px 0`,padding:'10px 14px',marginTop:10}}>
            <div style={{fontSize:10,fontWeight:800,color:DS.accent.teal,display:'flex',alignItems:'center',gap:4}}><Lightbulb size={12} strokeWidth={2}/>Examiner Insight</div>
            <p style={{margin:'4px 0 0',fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{q.insight}</p>
          </div>}
          <div style={{marginTop:12,background:DS.bg.surface,borderRadius:DS.radius.md,padding:12,border:`1px solid ${DS.border}`}}>
            <div style={{fontSize:10,fontWeight:700,color:DS.text.secondary,marginBottom:8}}>Self-mark: how many marks?</div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              {Array.from({length:q.marks+1},(_,i)=>i).map(m=>(
                <button key={m} onClick={()=>onSelfMark(m)} style={{padding:'7px 12px',borderRadius:DS.radius.sm,border:`1.5px solid ${selfMark===m?DS.accent.amber:DS.border}`,background:selfMark===m?DS.accent.amberDim:DS.bg.elevated,color:selfMark===m?DS.accent.amber:DS.text.secondary,fontWeight:800,fontSize:13,cursor:'pointer',transition:DS.tr}}>{m}/{q.marks}</button>
              ))}
            </div>
          </div>
          {working&&(
            <div style={{marginTop:10}}>
              <button onClick={handleAI} disabled={aiLoading} style={{width:'100%',padding:9,borderRadius:DS.radius.sm,border:`1.5px solid ${DS.borderHi}`,background:aiLoading?DS.bg.overlay:DS.bg.surface,color:aiLoading?DS.text.muted:DS.accent.amber,fontWeight:800,fontSize:12,cursor:aiLoading?'not-allowed':'pointer',transition:DS.tr}}>
                {aiLoading?'Marking...':'Get AI Feedback on My Working'}
              </button>
              {aiResult&&!aiResult.error&&(
                <div style={{marginTop:10,background:DS.bg.surface,border:`1.5px solid ${DS.borderHi}`,borderRadius:DS.radius.md,padding:14}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                    <span style={{fontSize:12,fontWeight:800,color:DS.text.primary}}>AI Feedback</span>
                    <div style={{width:38,height:38,borderRadius:'50%',background:aiResult.marksEarned===q.marks?DS.accent.tealDim:aiResult.marksEarned>0?DS.accent.amberDim:DS.accent.redDim,border:`2px solid ${aiResult.marksEarned===q.marks?DS.accent.teal:aiResult.marksEarned>0?DS.accent.amber:DS.accent.red}`,display:'flex',alignItems:'center',justifyContent:'center'}}>
                      <span style={{fontSize:11,fontWeight:900,color:aiResult.marksEarned===q.marks?DS.accent.teal:aiResult.marksEarned>0?DS.accent.amber:DS.accent.red}}>{aiResult.marksEarned}/{q.marks}</span>
                    </div>
                  </div>
                  {aiResult.feedback&&<div style={{borderLeft:`3px solid ${DS.accent.teal}`,paddingLeft:8,marginBottom:6}}><p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{aiResult.feedback}</p></div>}
                  {aiResult.improvements&&<div style={{borderLeft:`3px solid ${DS.accent.amber}`,paddingLeft:8,marginBottom:6}}><p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{aiResult.improvements}</p></div>}
                  {aiResult.breakdown?.map((m,i)=><div key={i} style={{fontSize:12,color:DS.text.muted,padding:'2px 0',fontFamily:'monospace'}}>{m}</div>)}
                  <SocraticChat question={q.q} ms={q.ms} aiResult={aiResult} maxMarks={q.marks}/>
                </div>
              )}
              {aiResult?.error&&<div style={{marginTop:8,background:DS.accent.redDim,borderRadius:DS.radius.sm,padding:'8px 12px',color:DS.accent.red,fontSize:12}}>{aiResult.error}</div>}
            </div>
          )}
        </div>
      )}
      <div style={{padding:'8px 18px',background:DS.bg.base,borderTop:`1px solid ${DS.border}`}}>
        <button onClick={()=>setShowMS(!showMS)} style={{width:'100%',padding:'7px 0',borderRadius:DS.radius.sm,border:`1.5px solid ${showMS?DS.accent.teal:DS.border}`,background:showMS?DS.accent.tealDim:'transparent',color:showMS?DS.accent.teal:DS.text.secondary,fontSize:11,fontWeight:700,cursor:'pointer',transition:DS.tr}}>
          {showMS?'Hide Mark Scheme':'Show Mark Scheme & Self-Mark'}
        </button>
      </div>
    </div>
  );
}

export function MockExam({onXP=()=>{},mode='sprint'}){
  const questions=useMemo(()=>shuffle(ALL_QUESTIONS).slice(0,20),[]);
  const TOTAL_TIME=45*60;
  const [timeLeft,setTimeLeft]=useState(TOTAL_TIME);
  const [started,setStarted]=useState(false);
  const [submitted,setSubmitted]=useState(false);
  const [workings,setWorkings]=useState({});
  const [selfMarks,setSelfMarks]=useState({});
  const xpAwarded=useRef(false);
  const handleSubmit=useCallback(()=>{
    if(!xpAwarded.current){
      xpAwarded.current=true;onXP(100);
      const earned=Object.values(selfMarks).reduce((s,m)=>s+m,0);
      const total=questions.reduce((s,q)=>s+q.marks,0);
      track('mock_exam_submitted',{score:earned,total,pct:total>0?Math.round(earned/total*100):0,timeUsed:TOTAL_TIME-timeLeft});
    }
    setSubmitted(true);
  },[onXP,selfMarks,questions,timeLeft]);

  useEffect(()=>{
    if(!started||submitted)return;
    if(timeLeft<=0){setTimeout(handleSubmit,0);return;}
    const t=setInterval(()=>setTimeLeft(s=>s-1),1000);
    return()=>clearInterval(t);
  },[started,submitted,timeLeft,handleSubmit]);

  const fmt=s=>`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  const totalMarks=questions.reduce((s,q)=>s+q.marks,0);
  const earnedMarks=Object.values(selfMarks).reduce((s,m)=>s+m,0);
  const markedCount=Object.keys(selfMarks).length;
  const pct=totalMarks>0?Math.round(earnedMarks/totalMarks*100):0;

  if(!started)return(
    <div style={{maxWidth:640,margin:'0 auto',padding:24,fontFamily:"'Inter','Segoe UI',sans-serif",background:mode==='deep'?DS.bg.deep:DS.bg.base,minHeight:'100vh'}}>
      <div style={{background:DS.bg.surface,borderRadius:DS.radius.xl,padding:32,textAlign:'center',marginBottom:16,border:`1px solid ${DS.border}`,boxShadow:DS.shadow}}>
        <div style={{width:64,height:64,borderRadius:'50%',background:DS.accent.amberDim,border:`2px solid ${DS.accent.amber}`,display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px'}}><FileText size={28} strokeWidth={2} color={DS.accent.amber}/></div>
        <div style={{fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:6}}>Timed Mock Exam</div>
        <div style={{fontSize:13,color:DS.text.secondary,marginBottom:24}}>20 mixed questions from all topics · 45 minutes</div>
        <div style={{display:'flex',gap:10,justifyContent:'center',flexWrap:'wrap'}}>
          {[{l:'Questions',v:'20'},{l:'Time',v:'45 min'},{l:'Topics',v:'Mixed'},{l:'Total Marks',v:String(totalMarks)}].map(s=>(
            <div key={s.l} style={{background:DS.bg.elevated,borderRadius:DS.radius.md,padding:'12px 18px',minWidth:80,border:`1px solid ${DS.border}`}}>
              <div style={{fontSize:22,fontWeight:900,color:DS.accent.amber}}>{s.v}</div>
              <div style={{fontSize:10,color:DS.text.muted,fontWeight:600,textTransform:'uppercase',letterSpacing:1}}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{background:DS.bg.surface,borderRadius:DS.radius.lg,padding:20,marginBottom:16,border:`1px solid ${DS.border}`}}>
        <div style={{fontSize:11,fontWeight:800,color:DS.text.secondary,textTransform:'uppercase',letterSpacing:1,marginBottom:12}}>Instructions</div>
        {['45 minutes for 20 questions from all topics.','Write your working in the boxes provided.','Submit when done — or the timer will auto-submit.','After submission, reveal each mark scheme and self-mark.','AI marking is available if you have an API key set up.'].map((t,i)=>(
          <div key={i} style={{display:'flex',gap:10,marginBottom:8,fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>
            <span style={{color:DS.accent.amber,fontWeight:700,flexShrink:0,minWidth:16}}>{i+1}.</span>{t}
          </div>
        ))}
      </div>
      <button onClick={()=>{setStarted(true);track('mock_exam_started',{questionCount:questions.length});}} style={{width:'100%',padding:16,borderRadius:DS.radius.md,border:'none',background:DS.accent.amber,color:DS.bg.deep,fontSize:15,fontWeight:900,cursor:'pointer',boxShadow:`0 4px 18px ${DS.accent.amberDim}`,transition:DS.tr}}>
        Start Exam
      </button>
    </div>
  );

  if(submitted){
    const mockBnd=markedCount>0?calcGrade(pct/100):null;
    // Module breakdown for results
    const modBreakdown=MODULES.map(m=>{
      const mQs=questions.map((q,i)=>({q,i})).filter(({q})=>m.topics.some(t=>t.id===q.topicId));
      const mMarked=mQs.filter(({i})=>selfMarks[i]!==undefined);
      const mEarned=mMarked.reduce((s,{i})=>s+selfMarks[i],0);
      const mTotal=mQs.reduce((s,{q})=>s+q.marks,0);
      return{...m,mQs:mQs.length,mMarked:mMarked.length,mEarned,mTotal,ratio:mTotal>0?mEarned/mTotal:null};
    }).filter(m=>m.mQs>0);
    return(
      <div style={{maxWidth:680,margin:'0 auto',padding:20,fontFamily:"'Inter','Segoe UI',sans-serif",background:mode==='deep'?DS.bg.deep:DS.bg.base,minHeight:'100vh'}}>
        <div style={{background:DS.bg.surface,borderRadius:DS.radius.xl,padding:28,textAlign:'center',marginBottom:16,border:`1px solid ${DS.border}`,boxShadow:DS.shadow,position:'relative',overflow:'hidden'}}>
          <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:`linear-gradient(90deg,${DS.accent.amber},${DS.accent.teal})`,opacity:0.7}}/>
          <div style={{width:72,height:72,borderRadius:'50%',background:pct>=70?DS.accent.amberDim:pct>=50?DS.accent.tealDim:DS.bg.elevated,border:`2px solid ${pct>=70?DS.accent.amber:pct>=50?DS.accent.teal:DS.border}`,display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px'}}>{pct>=70?<Trophy size={32} strokeWidth={2} color={DS.accent.amber}/>:pct>=50?<BarChart2 size={32} strokeWidth={2} color={DS.accent.teal}/>:<BookOpen size={32} strokeWidth={2} color={DS.text.muted}/>}</div>
          <div style={{fontSize:18,fontWeight:900,color:DS.text.primary,marginBottom:4}}>Exam Complete</div>
          {markedCount>0?(
            <>
              <div style={{fontSize:52,fontWeight:900,color:DS.accent.amber,lineHeight:1.1}}>{earnedMarks}<span style={{fontSize:24,color:DS.text.muted}}>/{totalMarks}</span></div>
              <div style={{fontSize:13,color:DS.text.secondary,marginTop:6}}>{pct}% · {markedCount}/{questions.length} self-marked</div>
              {mockBnd&&<div style={{marginTop:12,display:'inline-flex',alignItems:'center',gap:10,background:DS.bg.elevated,border:`1.5px solid ${mockBnd.color}55`,borderRadius:DS.radius.md,padding:'10px 20px'}}>
                <div style={{fontSize:40,fontWeight:900,color:mockBnd.color,lineHeight:1}}>{mockBnd.grade}</div>
                <div style={{textAlign:'left'}}><div style={{fontSize:10,fontWeight:800,color:DS.text.muted,textTransform:'uppercase',letterSpacing:1}}>Mock Grade</div><div style={{fontSize:11,color:DS.text.secondary,marginTop:2}}>Based on this exam</div></div>
              </div>}
            </>
          ):(
            <div style={{fontSize:13,color:DS.text.secondary,marginTop:8}}>Reveal each mark scheme below and self-mark to see your score</div>
          )}
        </div>

        {/* Module breakdown */}
        {markedCount>0&&modBreakdown.length>0&&(
          <div style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:'16px 18px',marginBottom:16}}>
            <div style={{fontSize:10,fontWeight:800,color:DS.text.muted,textTransform:'uppercase',letterSpacing:1.5,marginBottom:12}}>Module Breakdown</div>
            <div style={{display:'grid',gap:8}}>
              {modBreakdown.map(m=>(
                <div key={m.id} style={{display:'flex',alignItems:'center',gap:10}}>
                  <div style={{width:8,height:8,borderRadius:'50%',background:m.color,flexShrink:0}}/>
                  <div style={{fontSize:12,color:DS.text.secondary,flex:1,fontWeight:600}}>{m.label}</div>
                  <div style={{width:80,height:5,background:DS.bg.elevated,borderRadius:3,overflow:'hidden',flexShrink:0}}>
                    <div style={{height:'100%',background:m.ratio!==null?(m.ratio>=0.7?DS.accent.teal:m.ratio>=0.4?DS.accent.amber:DS.accent.red):DS.border,width:m.ratio!==null?`${Math.round(m.ratio*100)}%`:'0%',borderRadius:3}}/>
                  </div>
                  <div style={{fontSize:11,fontWeight:800,color:m.ratio!==null?(m.ratio>=0.7?DS.accent.teal:m.ratio>=0.4?DS.accent.amber:DS.accent.red):DS.text.muted,width:36,textAlign:'right',flexShrink:0}}>{m.ratio!==null?`${Math.round(m.ratio*100)}%`:'—'}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <button onClick={()=>{window.location.reload();}} style={{width:'100%',padding:'12px',borderRadius:DS.radius.md,border:`1px solid ${DS.border}`,background:'transparent',color:DS.text.secondary,fontWeight:700,fontSize:13,cursor:'pointer',marginBottom:14,display:'flex',alignItems:'center',justifyContent:'center',gap:7,transition:DS.tr}}>
          ↺ Retake Exam with New Questions
        </button>

        {questions.map((q,i)=>(
          <MockQCard key={q.qid} q={q} idx={i} working={workings[i]||''} selfMark={selfMarks[i]} onSelfMark={m=>setSelfMarks(s=>({...s,[i]:m}))}/>
        ))}
      </div>
    );
  }

  return(
    <div style={{maxWidth:680,margin:'0 auto',padding:20,fontFamily:"'Inter','Segoe UI',sans-serif",background:mode==='deep'?DS.bg.deep:DS.bg.base,minHeight:'100vh'}}>
      {/* Sticky timer bar */}
      <div style={{position:'sticky',top:52,zIndex:99,background:DS.bg.surface,borderRadius:DS.radius.md,padding:'10px 16px',marginBottom:14,boxShadow:DS.shadow,display:'flex',justifyContent:'space-between',alignItems:'center',border:`1px solid ${timeLeft<300?DS.accent.red:DS.border}`,overflow:'hidden'}}>
        <div>
          <div style={{fontSize:9,fontWeight:700,color:DS.text.muted,textTransform:'uppercase',letterSpacing:1}}>Time Remaining</div>
          <div style={{fontSize:24,fontWeight:900,color:timeLeft<300?DS.accent.red:DS.text.primary,fontFamily:'monospace'}}>{fmt(timeLeft)}</div>
        </div>
        <div style={{textAlign:'center'}}>
          <div style={{fontSize:9,fontWeight:700,color:DS.text.muted,textTransform:'uppercase',letterSpacing:1}}>Progress</div>
          <div style={{fontSize:13,fontWeight:800,color:DS.text.secondary}}>20 Qs · {totalMarks} marks</div>
        </div>
        <button onClick={handleSubmit} style={{padding:'9px 16px',borderRadius:DS.radius.sm,border:'none',background:DS.accent.amber,color:DS.bg.deep,fontWeight:900,fontSize:12,cursor:'pointer',transition:DS.tr}}>Submit →</button>
        {/* Amber progress line */}
        <div style={{position:'absolute',bottom:0,left:0,height:2,background:timeLeft<300?DS.accent.red:DS.accent.amber,width:`${(timeLeft/TOTAL_TIME)*100}%`,transition:'width 1s linear'}}/>
      </div>

      {questions.map((q,i)=>(
        <div key={q.qid} style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,marginBottom:10,overflow:'hidden'}}>
          <div style={{padding:'14px 18px'}}>
            <div style={{display:'flex',gap:8,marginBottom:10,alignItems:'center',flexWrap:'wrap'}}>
              <span style={{width:24,height:24,borderRadius:'50%',background:DS.accent.amberDim,border:`1px solid ${DS.accent.amber}`,color:DS.accent.amber,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:11,flexShrink:0}}>{i+1}</span>
              <span style={{background:(DIFF[q.diff]||DIFF.Mid).bg,color:(DIFF[q.diff]||DIFF.Mid).c,fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:6}}>{q.diff}</span>
              <span style={{fontSize:11,color:DS.text.muted,fontWeight:600}}>[{q.marks} mark{q.marks>1?'s':''}]</span>
              {mode!=='deep'&&<span style={{fontSize:10,color:DS.text.muted}}>{q.topicTitle}</span>}
            </div>
            <p style={{margin:'0 0 10px',fontSize:14,lineHeight:1.7,color:DS.text.primary,whiteSpace:'pre-line'}}>{q.q}</p>
            <textarea value={workings[i]||''} onChange={e=>setWorkings(w=>({...w,[i]:e.target.value}))} placeholder="Write your working here..." style={{width:'100%',minHeight:68,padding:10,borderRadius:DS.radius.sm,border:`1.5px solid ${DS.border}`,background:DS.bg.elevated,color:DS.text.primary,fontSize:13,fontFamily:'inherit',resize:'vertical',boxSizing:'border-box',outline:'none'}}/>
          </div>
        </div>
      ))}
      <button onClick={handleSubmit} style={{width:'100%',padding:14,borderRadius:DS.radius.md,border:'none',background:DS.accent.amber,color:DS.bg.deep,fontSize:14,fontWeight:900,cursor:'pointer',marginBottom:24,transition:DS.tr}}>
        Submit Exam
      </button>
    </div>
  );
}

// ═══ GENERATOR ════════════════════════════════════════════════════════════════
function buildPrompt(cfg){
  const styleRules={
    AQA:"AQA style: multi-step worded problems, 'show that' proofs, reward method marks explicitly at every step.",
    Edexcel:"Edexcel style: real-world applied context, 'evaluate/comment' questions (give verdict + justification), may not give formulae.",
    OCR:"OCR style: 'give a reason for each angle/step you find', justify decisions, more proof and 'show that' components."
  };
  return `You are a GCSE Mathematics examiner writing ${cfg.board} (${cfg.tier} tier) exam questions.\n\nGenerate EXACTLY ${cfg.count} question${cfg.count>1?"s":""} on: ${cfg.topicLabel}\n\nDifficulty: ${cfg.diff}\n- Starter: 1-2 marks, direct single-step application\n- Mid: 3-4 marks, multi-step or embedded in real context\n- Killer: 4-6 marks, multi-step with proof/"show that" or "evaluate and justify"\n\n${styleRules[cfg.board]}\n\nRespond ONLY with valid JSON (no markdown, no preamble):\n{\n  "questions": [\n    {\n      "question": "Full question text.",\n      "marks": 3,\n      "difficulty": "Mid",\n      "mark_scheme": ["M1: description", "A1: description"],\n      "working": "Complete step-by-step worked solution",\n      "examiner_insight": "What specifically earns or loses marks on ${cfg.board}",\n      "common_mistake": "The single most common error"\n    }\n  ]\n}`;
}

async function callAPI(cfg){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  if(!key)throw new Error('Add VITE_ANTHROPIC_API_KEY to .env.local to use the generator');
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:2000,messages:[{role:'user',content:buildPrompt(cfg)}]})
  });
  if(!res.ok){const d=await res.json();throw new Error(d.error?.message||`HTTP ${res.status}`);}
  const data=await res.json();
  const text=data.content.map(b=>b.text||'').join('');
  return JSON.parse(text.replace(/```json|```/g,'').trim());
}

function QCardGen({q,idx,board}){
  const [show,setShow]=useState("none");
  const d=(DIFF[q.difficulty]||DIFF.Mid);
  const bc=BCOLORS[board]||DS.accent.amber;
  const showWorking=show==="working"||show==="both";
  const showMarks=show==="marks"||show==="both";
  return(
    <div style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.lg,marginBottom:16,overflow:"hidden",boxShadow:DS.shadow,position:'relative'}}>
      {/* Left accent strip */}
      <div style={{position:'absolute',top:0,left:0,bottom:0,width:3,background:d.c}}/>
      <div style={{padding:"16px 20px 14px 20px"}}>
        <div style={{display:"flex",gap:7,alignItems:"center",flexWrap:"wrap",marginBottom:10}}>
          <div style={{width:26,height:26,borderRadius:"50%",background:DS.accent.amberDim,border:`1px solid ${DS.accent.amber}`,color:DS.accent.amber,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900,fontSize:11}}>{idx+1}</div>
          <span style={{background:`${bc}22`,color:bc,fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:4,letterSpacing:1}}>{board}</span>
          <span style={{background:d.bg,color:d.c,fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:6}}>{q.difficulty}</span>
          <span style={{fontSize:11,color:DS.text.muted,fontWeight:600}}>[{q.marks} mark{q.marks>1?"s":""}]</span>
        </div>
        <p style={{margin:0,fontSize:14,lineHeight:1.75,color:DS.text.primary,whiteSpace:"pre-line"}}>{q.question}</p>
      </div>
      {showWorking&&(
        <div style={{padding:"14px 20px",background:DS.bg.elevated,borderTop:`1px solid ${DS.border}`,borderBottom:`1px solid ${DS.border}`}}>
          <div style={{fontSize:10,fontWeight:800,color:DS.accent.amber,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Worked Solution</div>
          <div style={{fontSize:13,lineHeight:1.9,color:DS.text.secondary,whiteSpace:"pre-line",fontFamily:"'Courier New',monospace"}}>{q.working}</div>
        </div>
      )}
      {showMarks&&(
        <div style={{padding:"14px 20px",background:DS.bg.elevated,borderTop:`1px solid ${DS.border}`,borderBottom:`1px solid ${DS.border}`}}>
          <div style={{fontSize:10,fontWeight:800,color:DS.accent.teal,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Mark Scheme</div>
          {q.mark_scheme.map((m,i)=><div key={i} style={{fontSize:13,color:DS.text.secondary,padding:"4px 0",display:"flex",gap:8,borderBottom:`1px solid ${DS.border}`}}><span style={{color:DS.accent.teal,fontWeight:700,flexShrink:0}}>›</span>{m}</div>)}
          {q.examiner_insight&&<div style={{background:DS.bg.overlay,borderLeft:`3px solid ${DS.accent.teal}`,borderRadius:`0 ${DS.radius.sm}px ${DS.radius.sm}px 0`,padding:"10px 14px",marginTop:10}}>
            <div style={{fontSize:10,fontWeight:800,color:DS.accent.teal,marginBottom:4,textTransform:'uppercase',letterSpacing:1}}>{board} Examiner Insight</div>
            <p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.6}}>{q.examiner_insight}</p>
          </div>}
          {q.common_mistake&&<div style={{background:DS.accent.redDim,borderLeft:`3px solid ${DS.accent.red}`,borderRadius:`0 ${DS.radius.sm}px ${DS.radius.sm}px 0`,padding:"10px 14px",marginTop:8}}>
            <div style={{fontSize:10,fontWeight:800,color:DS.accent.red,marginBottom:4,textTransform:'uppercase',letterSpacing:1}}>Most Common Mistake</div>
            <p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.6}}>{q.common_mistake}</p>
          </div>}
        </div>
      )}
      <div style={{padding:"10px 18px",display:"flex",gap:7,background:DS.bg.base,flexWrap:"wrap"}}>
        <button onClick={()=>setShow(s=>s==="working"?"none":s==="marks"?"both":s==="both"?"marks":"working")}
          style={{flex:1,minWidth:110,padding:"7px 0",borderRadius:DS.radius.sm,border:`1.5px solid ${showWorking?DS.accent.amber:DS.border}`,background:showWorking?DS.accent.amberDim:'transparent',color:showWorking?DS.accent.amber:DS.text.secondary,fontSize:11,fontWeight:700,cursor:"pointer",transition:DS.tr}}>
          {showWorking?"Hide Working":"Show Working"}
        </button>
        <button onClick={()=>setShow(s=>s==="marks"?"none":s==="working"?"both":s==="both"?"working":"marks")}
          style={{flex:1,minWidth:110,padding:"7px 0",borderRadius:DS.radius.sm,border:`1.5px solid ${showMarks?DS.accent.teal:DS.border}`,background:showMarks?DS.accent.tealDim:'transparent',color:showMarks?DS.accent.teal:DS.text.secondary,fontSize:11,fontWeight:700,cursor:"pointer",transition:DS.tr}}>
          {showMarks?"Hide Mark Scheme":"Show Mark Scheme"}
        </button>
      </div>
    </div>
  );
}

export function Generator(){
  const isMobile=useIsMobile();
  const allGenTopics=useMemo(()=>MODULES.flatMap(m=>m.topics.map(t=>({id:t.id,label:t.title,module:m.label}))),[]);
  const [cfg,setCfg]=useState({board:"AQA",tier:"Higher",topic:"1.3",topicLabel:"Percentages",diff:"Mid",count:3});
  const [qs,setQs]=useState([]);
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState(null);
  const [total,setTotal]=useState(0);
  const [filterMod,setFilterMod]=useState("All");
  const modules=["All",...MODULES.map(m=>m.label)];
  const visibleTopics=filterMod==="All"?allGenTopics:allGenTopics.filter(t=>t.module===filterMod);

  const run=async()=>{
    setLoading(true);setErr(null);setQs([]);
    track('generator_used',{board:cfg.board,topic:cfg.topic,difficulty:cfg.diff,count:cfg.count});
    try{const data=await callAPI(cfg);setQs(data.questions);setTotal(t=>t+1);}
    catch(e){setErr(e.message);}
    setLoading(false);
  };

  return(
    <div style={{fontFamily:"'Inter','Segoe UI',sans-serif",maxWidth:860,margin:"0 auto",background:DS.bg.base,minHeight:"100vh"}}>
      {/* Header */}
      <div style={{background:DS.bg.surface,borderBottom:`1px solid ${DS.border}`,padding:"18px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:9,fontWeight:800,color:DS.accent.amber,letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>GCSE MATHS</div>
          <div style={{fontSize:20,fontWeight:900,color:DS.text.primary}}>AI Question Generator</div>
          <div style={{fontSize:12,color:DS.text.muted,marginTop:2}}>Infinite questions · Board-specific mark schemes · Examiner insights</div>
        </div>
        {total>0&&<div style={{background:DS.accent.amberDim,borderRadius:DS.radius.md,padding:"8px 18px",textAlign:"center",border:`1px solid ${DS.accent.amber}`}}>
          <div style={{fontSize:24,fontWeight:900,color:DS.accent.amber}}>{total}</div>
          <div style={{fontSize:9,color:DS.text.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>sets made</div>
        </div>}
      </div>
      <div style={{padding:"20px 24px"}}>
        {!import.meta.env.VITE_ANTHROPIC_API_KEY&&<div style={{background:DS.accent.amberDim,border:`1.5px solid ${DS.accent.amber}`,borderRadius:DS.radius.md,padding:'12px 16px',marginBottom:16,fontSize:13,color:DS.accent.amber}}>
          API key not set. Create <code>.env.local</code> with: <code>VITE_ANTHROPIC_API_KEY=sk-ant-...</code> then restart.
        </div>}
        <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"260px 1fr",gap:16,alignItems:"start"}}>
          {/* Sidebar */}
          <div style={{background:DS.bg.surface,borderRadius:DS.radius.lg,border:`1px solid ${DS.border}`,overflow:"hidden",position:isMobile?"static":"sticky",top:60}}>
            <div style={{padding:"14px 16px",borderBottom:`1px solid ${DS.border}`}}>
              <div style={{fontSize:9,fontWeight:800,color:DS.text.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Exam Board</div>
              <div style={{display:"flex",gap:5}}>
                {["AQA","Edexcel","OCR","Edexcel IGCSE"].map(b=><button key={b} onClick={()=>setCfg(c=>({...c,board:b}))} style={{flex:1,padding:"8px 0",borderRadius:DS.radius.sm,border:`1.5px solid ${cfg.board===b?BCOLORS[b]:DS.border}`,background:cfg.board===b?`${BCOLORS[b]}22`:DS.bg.elevated,color:cfg.board===b?BCOLORS[b]:DS.text.secondary,fontWeight:800,fontSize:11,cursor:"pointer",transition:DS.tr}}>{b}</button>)}
              </div>
            </div>
            <div style={{padding:"12px 16px",borderBottom:`1px solid ${DS.border}`}}>
              <div style={{fontSize:9,fontWeight:800,color:DS.text.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Tier</div>
              <div style={{display:"flex",gap:5}}>
                {["Foundation","Higher"].map(t=><button key={t} onClick={()=>setCfg(c=>({...c,tier:t}))} style={{flex:1,padding:"7px 0",borderRadius:DS.radius.sm,border:`1.5px solid ${cfg.tier===t?DS.accent.amber:DS.border}`,background:cfg.tier===t?DS.accent.amberDim:DS.bg.elevated,color:cfg.tier===t?DS.accent.amber:DS.text.secondary,fontWeight:700,fontSize:11,cursor:"pointer",transition:DS.tr}}>{t}</button>)}
              </div>
            </div>
            <div style={{padding:"12px 16px",borderBottom:`1px solid ${DS.border}`}}>
              <div style={{fontSize:9,fontWeight:800,color:DS.text.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Difficulty</div>
              <div style={{display:"grid",gap:5}}>
                {[{id:"Starter",desc:"1–2 marks · direct"},{id:"Mid",desc:"3–4 marks · multi-step"},{id:"Killer",desc:"4–6 marks · proof/evaluate"}].map(d=>{
                  const dc=DIFF[d.id];
                  return<button key={d.id} onClick={()=>setCfg(c=>({...c,diff:d.id}))} style={{padding:"8px 10px",borderRadius:DS.radius.sm,border:`1.5px solid ${cfg.diff===d.id?dc.c:DS.border}`,background:cfg.diff===d.id?dc.bg:DS.bg.elevated,textAlign:"left",cursor:"pointer",transition:DS.tr}}>
                    <div style={{fontSize:12,fontWeight:800,color:cfg.diff===d.id?dc.c:DS.text.secondary}}>{d.id}</div>
                    <div style={{fontSize:10,color:DS.text.muted}}>{d.desc}</div>
                  </button>;
                })}
              </div>
            </div>
            <div style={{padding:"12px 16px",borderBottom:`1px solid ${DS.border}`}}>
              <div style={{fontSize:9,fontWeight:800,color:DS.text.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>
                Questions: <span style={{color:DS.accent.amber,fontSize:14,fontWeight:900}}>{cfg.count}</span>
              </div>
              <input type="range" min={1} max={5} value={cfg.count} onChange={e=>setCfg(c=>({...c,count:+e.target.value}))} style={{width:"100%",accentColor:DS.accent.amber}}/>
            </div>
            <div style={{padding:"12px 16px"}}>
              <div style={{fontSize:9,fontWeight:800,color:DS.text.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Topic</div>
              <div style={{display:"flex",gap:4,marginBottom:8,flexWrap:"wrap"}}>
                {modules.map(m=><button key={m} onClick={()=>setFilterMod(m)} style={{padding:"3px 7px",borderRadius:5,border:"none",background:filterMod===m?(MCOLORS[m]||DS.accent.amber):DS.bg.overlay,color:filterMod===m?"#fff":DS.text.secondary,fontSize:9,fontWeight:700,cursor:"pointer"}}>{m==="All"?"All":m.split(" ")[0]}</button>)}
              </div>
              <div style={{maxHeight:200,overflowY:"auto",display:"grid",gap:4}}>
                {visibleTopics.map(t=><button key={t.id} onClick={()=>setCfg(c=>({...c,topic:t.id,topicLabel:t.label}))} style={{padding:"8px 10px",borderRadius:DS.radius.sm,border:`1.5px solid ${cfg.topic===t.id?(MCOLORS[t.module]||DS.accent.amber):DS.border}`,background:cfg.topic===t.id?DS.bg.overlay:DS.bg.elevated,textAlign:"left",cursor:"pointer",transition:DS.tr}}>
                  <div style={{fontSize:12,fontWeight:cfg.topic===t.id?700:400,color:cfg.topic===t.id?(MCOLORS[t.module]||DS.accent.amber):DS.text.secondary}}>{t.label}</div>
                  <div style={{fontSize:10,color:DS.text.muted}}>{t.module}</div>
                </button>)}
              </div>
            </div>
          </div>
          {/* Main content */}
          <div>
            <button onClick={run} disabled={loading} style={{width:"100%",padding:"15px",borderRadius:DS.radius.md,border:"none",background:loading?DS.bg.elevated:DS.accent.amber,color:loading?DS.text.muted:DS.bg.deep,fontSize:14,fontWeight:900,cursor:loading?"not-allowed":"pointer",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"center",gap:10,transition:DS.tr,boxShadow:loading?"none":`0 4px 18px ${DS.accent.amberDim}`}}>
              {loading?(<><Loader2 size={16} strokeWidth={2} style={{animation:"spin 0.8s linear infinite",color:DS.text.primary}}/>Generating {cfg.count} question{cfg.count>1?"s":""}...</>)
                :`Generate ${cfg.count} ${cfg.topicLabel} — ${cfg.board} ${cfg.tier} ${cfg.diff}`}
            </button>
            {err&&<div style={{background:DS.accent.redDim,border:`1.5px solid ${DS.accent.red}`,borderRadius:DS.radius.md,padding:"12px 16px",marginBottom:14,color:DS.accent.red,fontSize:13}}>{err}</div>}
            {loading&&!qs.length&&<div style={{textAlign:"center",padding:"60px 20px",color:DS.text.muted}}>
              <div style={{fontSize:36,marginBottom:12,display:'flex',justifyContent:'center'}}><Zap size={36} strokeWidth={2} color={DS.accent.amber}/></div>
              <div style={{fontSize:15,fontWeight:700,color:DS.text.primary,marginBottom:6}}>Writing your questions...</div>
              <div style={{fontSize:13,color:DS.text.secondary}}>Creating {cfg.board}-style {cfg.diff} questions on {cfg.topicLabel}</div>
            </div>}
            {qs.length>0&&!loading&&<>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div style={{fontSize:10,fontWeight:800,color:DS.text.muted,textTransform:"uppercase",letterSpacing:1}}>{qs.length} question{qs.length>1?"s":""} generated</div>
                <button onClick={run} style={{background:"none",border:`1.5px solid ${DS.border}`,borderRadius:DS.radius.sm,padding:"6px 12px",fontSize:11,fontWeight:700,color:DS.text.secondary,cursor:"pointer",transition:DS.tr}}>↺ Regenerate</button>
              </div>
              {qs.map((q,i)=><QCardGen key={`${total}-${i}`} q={q} idx={i} board={cfg.board}/>)}
            </>}
            {!qs.length&&!loading&&<div style={{textAlign:"center",padding:"60px 20px"}}>
              <div style={{fontSize:52,marginBottom:14}}>📐</div>
              <div style={{fontSize:16,fontWeight:800,color:DS.text.primary,marginBottom:8}}>Ready to generate</div>
              <p style={{color:DS.text.secondary,fontSize:13,maxWidth:300,margin:"0 auto",lineHeight:1.6}}>Choose your board, tier, topic and difficulty, then hit Generate.</p>
            </div>}
          </div>
        </div>
      </div>
    </div>
  );
}
