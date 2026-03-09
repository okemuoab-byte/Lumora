import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ═══ STORAGE & AUTH ══════════════════════════════════════════════════════════
let _currentUser=null;// set on login/init — email string
const GLOBAL_KEYS=new Set(['lumora_users','lumora_currentUser','lumora_sound']);
function lsKey(k){return(!GLOBAL_KEYS.has(k)&&_currentUser)?`lumora_${_currentUser}_${k}`:k;}
function lsGet(k,d){try{const v=localStorage.getItem(lsKey(k));return v!=null?JSON.parse(v):d;}catch{return d;}}
function lsSet(k,v){localStorage.setItem(lsKey(k),JSON.stringify(v));}

// Auth helpers
async function sha256(str){
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function getUsers(){try{return JSON.parse(localStorage.getItem('lumora_users')||'{}');}catch{return {};}}
function saveUsers(u){localStorage.setItem('lumora_users',JSON.stringify(u));}
function getCurrentUserEmail(){return localStorage.getItem('lumora_currentUser');}
function clearCurrentUser(){localStorage.removeItem('lumora_currentUser');_currentUser=null;}
function initCurrentUser(email){
  _currentUser=email;
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
  {name:'Bronze',min:0,max:499,icon:'🥉',color:'#CD7F32'},
  {name:'Silver',min:500,max:1499,icon:'🥈',color:'#A8A9AD'},
  {name:'Gold',min:1500,max:3499,icon:'🥇',color:'#D4A017'},
  {name:'Platinum',min:3500,max:Infinity,icon:'💎',color:'#7B68EE'},
];
function getLevel(xp){return LEVELS.find(l=>xp>=l.min&&xp<=l.max)||LEVELS[0];}
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
function isDailyDone(){const d=lsGet('lumora_daily',{date:null,completed:false});return d.date===todayStr()&&d.completed;}
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
      boards:{AQA:"Direct: 'Round 0.007462 to 2 s.f.' Expects answer clearly shown. Upper/lower bounds use < not ≤.",Edexcel:"Context-based: 'Give your answer to an appropriate degree of accuracy'. Bounds: compute max/min of A÷B.",OCR:"Justify rounding: 'Explain why 3 s.f. is appropriate'. Error intervals as a ≤ x < b."},
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
const BCOLORS={AQA:"#1B2A4A",Edexcel:"#C0392B",OCR:"#0D6E72"};

// ═══ ANIMATION STYLES ════════════════════════════════════════════════════════
function AnimStyles(){
  return(
    <style>{`
      @keyframes celebPop{0%{transform:scale(0.5);opacity:0}60%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
      @keyframes celebFade{0%{opacity:1}70%{opacity:1}100%{opacity:0}}
      @keyframes fadeInUp{0%{transform:translateY(20px);opacity:0}100%{transform:translateY(0);opacity:1}}
      @keyframes ringFill{0%{stroke-dashoffset:var(--circ)}100%{stroke-dashoffset:var(--offset)}}
      @keyframes slideIn{0%{transform:translateX(-12px);opacity:0}100%{transform:translateX(0);opacity:1}}
      @keyframes pulseAmber{0%,100%{box-shadow:0 0 0 0 rgba(245,183,0,0.0)}50%{box-shadow:0 0 0 6px rgba(245,183,0,0.18)}}
      @keyframes dotPulse{0%,80%,100%{opacity:0.2}40%{opacity:1}}
      @keyframes spin{to{transform:rotate(360deg)}}
      @keyframes slideUp{0%{transform:translateY(30px);opacity:0}100%{transform:translateY(0);opacity:1}}
      @keyframes popIn{0%{transform:scale(0.8);opacity:0}60%{transform:scale(1.05)}100%{transform:scale(1);opacity:1}}
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
function PredictedGrade({perf}){
  const entries=Object.values(perf).filter(p=>p.total>0);
  if(!entries.length)return(
    <div style={{textAlign:'center',padding:'16px 12px'}}>
      <div style={{fontSize:44,fontWeight:900,color:DS.accent.amber,lineHeight:1}}>–</div>
      <div style={{fontSize:11,fontWeight:800,color:DS.text.secondary,marginTop:4}}>Predicted Grade</div>
      <div style={{fontSize:10,color:DS.text.muted,marginTop:2}}>Answer questions to unlock</div>
    </div>
  );
  const avg=entries.reduce((s,p)=>s+(p.correct/p.total),0)/entries.length;
  const grade=avg>=0.9?'9':avg>=0.80?'8':avg>=0.70?'7':avg>=0.60?'6':avg>=0.50?'5':avg>=0.40?'4':'U';
  const gradeColor=avg>=0.70?DS.accent.teal:avg>=0.50?DS.accent.amber:DS.accent.red;
  return(
    <div style={{textAlign:'center',padding:'16px 12px'}}>
      <div style={{fontSize:52,fontWeight:900,color:gradeColor,lineHeight:1}}>{grade}</div>
      <div style={{fontSize:11,fontWeight:800,color:DS.text.secondary,marginTop:4}}>Predicted Grade</div>
      <div style={{fontSize:10,color:DS.text.muted,marginTop:2}}>{Math.round(avg*100)}% avg · {entries.length} topics</div>
    </div>
  );
}

// ═══ STUDY MODE TOGGLE ════════════════════════════════════════════════════════
function StudyModeToggle({mode,setMode}){
  return(
    <div style={{display:'flex',gap:2,background:DS.bg.elevated,borderRadius:DS.radius.sm,padding:2,border:`1px solid ${DS.border}`}}>
      {[{id:'sprint',label:'⚡ Sprint'},{id:'deep',label:'🎯 Focus'}].map(m=>(
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
        <span style={{fontSize:20,flexShrink:0}}>{lvl.icon}</span>
        <div style={{minWidth:0}}>
          <div style={{fontSize:12,fontWeight:800,color:DS.text.primary,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{lvl.name} · {xp} XP</div>
          <div style={{fontSize:9,color:DS.text.muted}}>{next?`${next.min-xp} XP to ${next.name}`:'Max level 🏆'}</div>
        </div>
      </div>
      <div style={{flex:2,minWidth:60}}>
        <div style={{background:DS.bg.elevated,borderRadius:4,height:6,overflow:'hidden'}}>
          <div style={{height:'100%',borderRadius:4,background:`linear-gradient(90deg,${DS.accent.amber},${DS.accent.teal})`,width:`${pct}%`,transition:'width 0.6s ease'}}/>
        </div>
        <div style={{fontSize:9,color:DS.text.muted,marginTop:2,textAlign:'right'}}>{pct}%</div>
      </div>
      <div style={{display:'flex',alignItems:'center',gap:4,flexShrink:0}}>
        <span style={{fontSize:16}}>🔥</span>
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

  // Grade calculation (spec thresholds)
  const gradeThresholds=[[95,9],[90,8],[80,7],[70,6],[60,5],[50,4],[35,3],[20,2],[0,1]];
  const pctToGrade=p=>(gradeThresholds.find(([t])=>p>=t)||[0,1])[1];
  const perfEntries=Object.values(perf).filter(p=>p.total>0);
  const totalQsDone=perfEntries.reduce((s,p)=>s+p.total,0);
  const avg=perfEntries.length>0
    ?perfEntries.reduce((s,p)=>s+p.correct/p.total,0)/perfEntries.length
    :null;
  const avgPct=avg!==null?Math.round(avg*100):null;
  const currentGrade=avgPct!==null?pctToGrade(avgPct):null;
  const nextGradeMinPcts=[0,20,35,50,60,70,80,90,95]; // [grade-1] = pct needed
  const gapToNext=currentGrade&&currentGrade<9?nextGradeMinPcts[currentGrade]-avgPct:0;
  const gradeColor=currentGrade>=7?DS.accent.teal:currentGrade>=5?DS.accent.amber:DS.accent.red;

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
            <div style={{fontSize:11,color:DS.text.muted,marginTop:3}}>{lvl.icon} {lvl.name} · {xp} XP</div>
          </div>
          {days!==null?(
            <div style={{background:DS.bg.elevated,borderRadius:DS.radius.md,padding:'8px 14px',border:`1px solid ${DS.border}`,textAlign:'center',flexShrink:0}}>
              <div style={{fontSize:24,fontWeight:900,color:DS.accent.amber,lineHeight:1}}>{days}</div>
              <div style={{fontSize:9,color:DS.text.muted,fontWeight:700,textTransform:'uppercase',letterSpacing:0.5}}>days to exam</div>
              {profile?.board&&<div style={{fontSize:9,color:DS.text.secondary,marginTop:1}}>{profile.board}</div>}
            </div>
          ):(
            <div style={{background:DS.accent.amberDim,borderRadius:DS.radius.md,padding:'8px 12px',border:`1px solid ${DS.accent.amber}33`,fontSize:11,color:DS.accent.amber,fontWeight:700,flexShrink:0}}>
              📅 Set exam date
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
                {gapToNext>0&&weakestForGrade&&(
                  <div style={{fontSize:9,color:DS.text.secondary,marginTop:5,lineHeight:1.4,borderTop:`1px solid ${DS.border}`,paddingTop:5}}>
                    +{gapToNext}% in <span style={{color:DS.accent.amber,fontWeight:700}}>{weakestForGrade.title.split(' ').slice(0,2).join(' ')}</span> → Grade {currentGrade+1}
                  </div>
                )}
                {currentGrade===9&&<div style={{fontSize:9,color:DS.accent.teal,marginTop:5,fontWeight:700}}>🏆 Maximum grade!</div>}
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
              {[{icon:'📝',val:weeklyStats.qCount,label:'Qs'},{icon:'🔥',val:streak.current,label:'Streak'},{icon:'⚡',val:xpThisWeek,label:'XP'}].map(s=>(
                <div key={s.label} style={{textAlign:'center'}}>
                  <div style={{fontSize:12,marginBottom:2}}>{s.icon}</div>
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
          {shareLoading?'⏳ Generating report…':'📊 Share Progress Report'}
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
        <div style={{fontSize:11,fontWeight:800,color:DS.accent.amber}}>⚡ Weekly Goal</div>
        <div style={{fontSize:12,fontWeight:900,color:d.count>=goal?DS.accent.teal:DS.text.primary}}>
          {d.count}<span style={{color:DS.text.muted,fontWeight:400}}>/{goal} days</span>
        </div>
      </div>
      <div style={{display:'flex',gap:4,marginBottom:nudge||d.count>=goal?8:0}}>
        {Array.from({length:goal},(_,i)=>(
          <div key={i} style={{flex:1,height:5,borderRadius:3,background:i<d.count?DS.accent.amber:DS.bg.elevated,transition:'background 0.3s ease'}}/>
        ))}
      </div>
      {nudge&&<div style={{fontSize:11,color:DS.accent.amber,fontWeight:700}}>One more to hit your weekly goal! 🎯</div>}
      {d.count>=goal&&<div style={{fontSize:11,color:DS.accent.teal,fontWeight:700}}>✓ Weekly goal smashed! 🏆</div>}
    </div>
  );
}

// ═══ ONBOARDING ════════════════════════════════════════════════════════════════
function Onboarding({onComplete}){
  const [step,setStep]=useState(1);
  const [profile,setProfile]=useState({name:'',board:'AQA',grade:'7',examDate:'',weaknesses:[]});
  const boards=['AQA','Edexcel','OCR'];
  const grades=['9','8','7','6','5','4'];
  const allTopics=MODULES.flatMap(m=>m.topics.map(t=>({id:t.id,title:t.title,module:m.label,color:m.color})));
  const update=(k,v)=>setProfile(p=>({...p,[k]:v}));
  const toggleWeak=(id)=>{
    const cur=profile.weaknesses;
    if(cur.includes(id)){update('weaknesses',cur.filter(x=>x!==id));}
    else if(cur.length<3){update('weaknesses',[...cur,id]);}
  };
  const weeks=profile.examDate?Math.max(0,Math.round((new Date(profile.examDate)-Date.now())/(1000*60*60*24*7))):null;
  const canNext=(
    (step===1&&profile.name.trim().length>=2)||
    step===2||step===3||
    (step===4&&profile.examDate)||
    (step===5&&profile.weaknesses.length>0)
  );
  const handleNext=()=>{
    if(step<5){setStep(s=>s+1);}
    else{lsSet('lumora_profile',{...profile,createdAt:new Date().toISOString()});onComplete(profile);}
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
              <div style={{fontSize:36,marginBottom:8}}>📋</div>
              <div style={{fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:6}}>Which exam board?</div>
              <div style={{fontSize:13,color:DS.text.secondary,marginBottom:20}}>We'll highlight board-specific tips for you</div>
              <div style={{display:'grid',gap:10}}>
                {boards.map(b=>(
                  <button key={b} onClick={()=>update('board',b)} style={{padding:'16px 20px',borderRadius:DS.radius.md,border:`1.5px solid ${profile.board===b?DS.accent.amber:DS.border}`,background:profile.board===b?DS.accent.amberDim:DS.bg.elevated,color:profile.board===b?DS.accent.amber:DS.text.primary,fontWeight:700,fontSize:14,cursor:'pointer',textAlign:'left',display:'flex',alignItems:'center',justifyContent:'space-between',transition:DS.tr}}>
                    {b}{profile.board===b&&<span style={{color:DS.accent.amber}}>✓</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
          {step===3&&(
            <div style={{animation:'fadeInUp 0.3s ease'}}>
              <div style={{fontSize:36,marginBottom:8}}>🎯</div>
              <div style={{fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:6}}>Target grade?</div>
              <div style={{fontSize:13,color:DS.text.secondary,marginBottom:20}}>Lumora will tune difficulty to your goal</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10}}>
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
              <div style={{fontSize:36,marginBottom:8}}>📅</div>
              <div style={{fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:6}}>When's your exam?</div>
              <div style={{fontSize:13,color:DS.text.secondary,marginBottom:20}}>We'll create a revision countdown for you</div>
              <input type="date" value={profile.examDate} onChange={e=>update('examDate',e.target.value)} style={{width:'100%',padding:'14px 16px',borderRadius:DS.radius.md,border:`1.5px solid ${DS.border}`,fontSize:16,fontFamily:'inherit',outline:'none',boxSizing:'border-box',color:DS.text.primary,background:DS.bg.elevated,colorScheme:'dark'}} onFocus={e=>e.target.style.borderColor=DS.accent.amber} onBlur={e=>e.target.style.borderColor=DS.border}/>
              {weeks!==null&&<div style={{marginTop:12,background:DS.accent.amberDim,borderRadius:DS.radius.md,padding:'12px 16px',fontSize:13,color:DS.accent.amber,fontWeight:700,border:`1px solid ${DS.accent.amber}33`}}>📆 {weeks} week{weeks!==1?'s':''} to go — let's make every session count</div>}
            </div>
          )}
          {step===5&&(
            <div style={{animation:'fadeInUp 0.3s ease'}}>
              <div style={{fontSize:36,marginBottom:8}}>📊</div>
              <div style={{fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:6}}>Your biggest weaknesses?</div>
              <div style={{fontSize:13,color:DS.text.secondary,marginBottom:16}}>Pick up to 3 topics — we'll prioritise these first</div>
              <div style={{maxHeight:280,overflowY:'auto',display:'grid',gap:6}}>
                {allTopics.map(t=>{
                  const sel=profile.weaknesses.includes(t.id);
                  const dis=!sel&&profile.weaknesses.length>=3;
                  return(
                    <button key={t.id} onClick={()=>!dis&&toggleWeak(t.id)} style={{padding:'10px 14px',borderRadius:DS.radius.sm,border:`1.5px solid ${sel?DS.accent.amber:DS.border}`,background:sel?DS.accent.amberDim:DS.bg.elevated,color:sel?DS.accent.amber:DS.text.secondary,fontWeight:sel?700:400,fontSize:12,cursor:dis?'not-allowed':'pointer',textAlign:'left',opacity:dis?0.4:1,display:'flex',justifyContent:'space-between',alignItems:'center',transition:DS.tr}}>
                      <span>{t.title}</span>{sel&&<span style={{color:DS.accent.amber}}>✓</span>}
                    </button>
                  );
                })}
              </div>
              <div style={{fontSize:11,color:DS.text.muted,marginTop:8}}>{profile.weaknesses.length}/3 selected</div>
            </div>
          )}
          <button onClick={handleNext} disabled={!canNext} style={{marginTop:24,width:'100%',padding:'15px 0',borderRadius:DS.radius.md,border:'none',background:canNext?DS.accent.amber:DS.bg.overlay,color:canNext?DS.bg.base:DS.text.muted,fontWeight:900,fontSize:15,cursor:canNext?'pointer':'not-allowed',transition:DS.tr}}>
            {step<5?'Continue →':`Let's go, ${profile.name}! 🚀`}
          </button>
          {step>1&&<button onClick={()=>setStep(s=>s-1)} style={{marginTop:8,width:'100%',padding:'10px 0',borderRadius:DS.radius.md,border:'none',background:'transparent',color:DS.text.muted,fontSize:13,cursor:'pointer'}}>← Back</button>}
        </div>
      </div>
    </div>
  );
}

// ═══ LANDING PAGE ════════════════════════════════════════════════════════════
function LandingPage({onStart}){
  const profile=lsGet('lumora_profile',null);
  const weeks=profile?.examDate?Math.max(0,Math.round((new Date(profile.examDate)-Date.now())/(1000*60*60*24*7))):null;
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
              Welcome back, {profile.name}! {lvl.icon} {xp} XP · 🔥 {streak.current} day streak{weeks!==null?` · 📅 ${weeks}w to exam`:''}
            </div>
          </div>
        )}
        <div style={{fontSize:48,marginBottom:16}}>🎓</div>
        <h1 style={{fontSize:40,fontWeight:900,color:DS.text.primary,lineHeight:1.1,margin:'0 0 16px'}}>Meet <span style={{color:DS.accent.amber}}>Lumora</span></h1>
        <p style={{fontSize:17,color:DS.text.secondary,lineHeight:1.6,margin:'0 0 32px'}}>The AI tutor that thinks like your best teacher</p>
        <button onClick={onStart} style={{padding:'16px 40px',borderRadius:50,border:'none',background:`linear-gradient(135deg,${DS.accent.amber},#E8B84B)`,color:DS.bg.base,fontWeight:900,fontSize:16,cursor:'pointer',boxShadow:`0 8px 32px ${DS.accent.amber}44`}}>
          {profile?'Continue Learning →':'Start Free — No credit card needed'}
        </button>
      </div>
      <div style={{background:DS.bg.surface,padding:'40px 24px'}}>
        <div style={{maxWidth:680,margin:'0 auto'}}>
          <div style={{textAlign:'center',fontSize:12,fontWeight:800,color:DS.accent.amber,letterSpacing:2,textTransform:'uppercase',marginBottom:24}}>The Problem With Traditional Revision</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14,textAlign:'center'}}>
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
          {[{n:1,icon:'📝',t:'Practice',d:'Work through exam-style questions at 3 difficulty levels across all GCSE Maths topics'},{n:2,icon:'🤖',t:'AI Marks Your Working',d:'Claude analyses your method step-by-step, just like a real examiner would'},{n:3,icon:'📊',t:'Progress Tracked',d:'Spaced repetition schedules your revision. Heatmaps show exactly where to focus next'},{n:4,icon:'🏆',t:'Level Up',d:'Earn XP, build streaks, and unlock levels as you improve. Revision that actually feels rewarding'}].map(s=>(
            <div key={s.n} style={{display:'flex',gap:16,alignItems:'flex-start',background:DS.bg.surface,borderRadius:DS.radius.lg,padding:'18px 20px',border:`1px solid ${DS.border}`}}>
              <div style={{width:40,height:40,borderRadius:DS.radius.sm,background:DS.accent.amberDim,border:`1px solid ${DS.accent.amber}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20,flexShrink:0}}>{s.icon}</div>
              <div><div style={{fontSize:15,fontWeight:800,color:DS.text.primary,marginBottom:4}}>{s.t}</div><div style={{fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{s.d}</div></div>
            </div>
          ))}
        </div>
      </div>
      <div style={{background:DS.bg.surface,padding:'48px 24px'}}>
        <div style={{maxWidth:680,margin:'0 auto'}}>
          <div style={{textAlign:'center',fontSize:12,fontWeight:800,color:DS.accent.amber,letterSpacing:2,textTransform:'uppercase',marginBottom:8}}>Pricing</div>
          <div style={{textAlign:'center',fontSize:22,fontWeight:900,color:DS.text.primary,marginBottom:28}}>Simple, fair pricing</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14}}>
            {[{name:'Free',price:'£0',period:' forever',features:['All topics & questions','AI marking (5/day)','Spaced repetition','Streak tracking'],cta:'Start Free',hi:false},{name:'Student Plus',price:'£7.99',period:'/mo',features:['Unlimited AI marking','Socratic tutoring','Progress reports','XP & level system'],cta:'Start 7-day trial',hi:true},{name:'Tutor Connect',price:'£12.99',period:'/mo',features:['Everything in Plus','Parent dashboard','Tutor assignment','Weekly reports'],cta:'Get started',hi:false}].map(p=>(
              <div key={p.name} style={{background:p.hi?DS.accent.amber:DS.bg.elevated,borderRadius:DS.radius.lg,padding:'22px 16px',border:p.hi?'none':`1px solid ${DS.border}`,position:'relative'}}>
                {p.hi&&<div style={{position:'absolute',top:-10,left:'50%',transform:'translateX(-50%)',background:DS.bg.elevated,color:DS.accent.amber,fontSize:8,fontWeight:800,padding:'3px 10px',borderRadius:6,letterSpacing:1,whiteSpace:'nowrap',border:`1px solid ${DS.accent.amber}44`}}>MOST POPULAR</div>}
                <div style={{fontSize:14,fontWeight:800,color:p.hi?DS.bg.base:DS.text.primary,marginBottom:4}}>{p.name}</div>
                <div style={{fontSize:28,fontWeight:900,color:p.hi?DS.bg.base:DS.accent.amber,marginBottom:2}}>{p.price}<span style={{fontSize:11,fontWeight:500}}>{p.period}</span></div>
                <div style={{margin:'14px 0',borderTop:`1px solid ${p.hi?'rgba(0,0,0,0.15)':DS.border}`,paddingTop:14}}>
                  {p.features.map(f=><div key={f} style={{fontSize:10,color:p.hi?DS.bg.base:DS.text.secondary,marginBottom:5,display:'flex',gap:5}}><span style={{fontWeight:800}}>✓</span>{f}</div>)}
                </div>
                <button onClick={onStart} style={{width:'100%',padding:'9px 0',borderRadius:DS.radius.sm,border:'none',background:p.hi?DS.bg.base:DS.bg.overlay,color:p.hi?DS.accent.amber:DS.text.secondary,fontWeight:800,fontSize:11,cursor:'pointer'}}>{p.cta}</button>
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
        <div style={{fontSize:52,marginBottom:16}}>📅</div>
        <div style={{fontSize:20,fontWeight:900,color:DS.text.primary,marginBottom:6}}>Daily Challenge</div>
        <div style={{fontSize:13,color:DS.text.muted,marginBottom:24}}>Preparing today's questions…</div>
        <div style={{width:36,height:36,border:`3px solid ${DS.border}`,borderTopColor:DS.accent.amber,borderRadius:'50%',animation:'spin 0.8s linear infinite',margin:'0 auto'}}/>
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
              <div style={{fontSize:26,fontWeight:900,color:DS.accent.red}}>🔥 {streakInfo?.streak||streak.current}</div>
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
        <div style={{fontSize:40,marginBottom:12}}>⚠️</div>
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
          <div style={{fontSize:10,color:DS.text.muted,marginTop:1}}>🔥 {streak.current} day streak{profile?` · ${profile.name}`:''}</div>
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
                {q.insight&&<div style={{background:DS.bg.surface,borderLeft:`3px solid ${DS.accent.teal}`,borderRadius:`0 6px 6px 0`,padding:'8px 12px',marginTop:8}}><p style={{margin:0,fontSize:12,color:DS.text.secondary,lineHeight:1.5}}>💡 {q.insight}</p></div>}
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
                {aiLoading?'🤖 Marking…':'🤖 Get AI Feedback'}
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
      const users=getUsers();
      const u=users[email.trim().toLowerCase()];
      if(!u){setErr('No account found for that email.');return;}
      const hash=await sha256(pw);
      if(hash!==u.passwordHash){setErr('Incorrect password.');return;}
      initCurrentUser(email.trim().toLowerCase());
      onLogin();
    }catch{setErr('Something went wrong. Try again.');}
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
      const users=getUsers();
      const key=email.trim().toLowerCase();
      if(users[key]){setErr('An account with this email already exists.');return;}
      const hash=await sha256(pw);
      const profile=lsGet('lumora_profile',{});
      users[key]={name:profile.name||'Student',passwordHash:hash,createdAt:new Date().toISOString()};
      saveUsers(users);
      initCurrentUser(key);
      onCreated();
    }catch{setErr('Something went wrong. Try again.');}
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
  const users=getUsers();
  const email=getCurrentUserEmail()||'';
  const u=users[email]||{};
  const [showLogoutConfirm,setShowLogoutConfirm]=useState(false);

  return(
    <div style={{position:'fixed',inset:0,zIndex:200,display:'flex',alignItems:'flex-start',justifyContent:'flex-end'}}>
      <div onClick={onClose} style={{position:'absolute',inset:0,background:'rgba(0,0,0,0.55)'}}/>
      <div style={{position:'relative',width:320,height:'100%',background:DS.bg.surface,borderLeft:`1px solid ${DS.border}`,padding:'24px 20px',display:'flex',flexDirection:'column',gap:20,overflowY:'auto',boxShadow:DS.shadow}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div style={{fontSize:16,fontWeight:800,color:DS.text.primary}}>Account</div>
          <button onClick={onClose} style={{background:'none',border:'none',color:DS.text.muted,fontSize:20,cursor:'pointer',lineHeight:1}}>×</button>
        </div>

        <div style={{background:DS.bg.elevated,borderRadius:DS.radius.lg,padding:16,border:`1px solid ${DS.border}`}}>
          <div style={{fontSize:18,fontWeight:800,color:DS.text.primary,marginBottom:2}}>{profile.name||u.name||'Student'}</div>
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
              {label:'Account Created',value:u.createdAt?new Date(u.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'short'}):'—'},
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
          <div style={{textAlign:'center',marginTop:14,fontSize:11,color:DS.text.muted}}>🔒 Data stored on this device only</div>
        </div>
      </div>
    </div>
  );
}

// ═══ APP SHELL ═══════════════════════════════════════════════════════════════
export default function App(){
  const [screen,setScreen]=useState(()=>{
    const cu=getCurrentUserEmail();
    if(cu){initCurrentUser(cu);return'landing';}
    const hasUsers=Object.keys(getUsers()).length>0;
    if(hasUsers)return'auth';
    const existingProfile=localStorage.getItem('lumora_profile');
    return existingProfile?'account_create':'onboarding';
  });
  const [page,setPage]=useState("platform");
  const [xpV,setXpV]=useState(0);
  const [celebration,setCelebration]=useState(null);
  const [mode,setMode]=useState('sprint');
  const [showDailyModal,setShowDailyModal]=useState(false);
  const [soundOn,setSoundOn]=useState(()=>lsGet('lumora_sound',true));
  const [showSettings,setShowSettings]=useState(false);

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

  const handleOnboardingComplete=()=>{touchStreak();setScreen('account_create');};
  const handleLogout=()=>{clearCurrentUser();setScreen('auth');setShowSettings(false);};

  if(screen==='onboarding')return<><AnimStyles/><Onboarding onComplete={handleOnboardingComplete}/></>;
  if(screen==='account_create')return<AccountCreateScreen onCreated={()=>{touchStreak();setScreen('landing');}}/>;
  if(screen==='auth')return<LoginScreen onLogin={()=>setScreen('landing')} onRegister={()=>setScreen('onboarding')}/>;
  if(screen==='landing')return<><AnimStyles/><LandingPage onStart={()=>setScreen('app')}/></>;

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
      <div style={{background:DS.bg.surface,padding:"0 16px",display:"flex",alignItems:"center",position:"sticky",top:0,zIndex:100,borderBottom:`1px solid ${DS.border}`,gap:4,boxShadow:DS.shadow}}>
        <button onClick={()=>setPage('platform')} style={{fontSize:14,fontWeight:900,color:DS.accent.amber,letterSpacing:0.5,padding:"14px 0",whiteSpace:"nowrap",background:'none',border:'none',cursor:'pointer'}}>📐 Lumora</button>
        {/* Streak pill — prominent, next to logo */}
        <div style={{display:'flex',alignItems:'center',gap:3,marginLeft:6,marginRight:8,background:streak.current>0?DS.accent.redDim:'transparent',borderRadius:DS.radius.sm,padding:'3px 8px',border:streak.current>0?`1px solid rgba(255,76,76,0.25)`:'none',flexShrink:0}}>
          <span style={{fontSize:14}}>🔥</span>
          <span style={{fontSize:13,fontWeight:900,color:streak.current>0?DS.accent.red:DS.text.muted,lineHeight:1}}>{streak.current}</span>
        </div>
        {[{id:"platform",label:"📚 Revision"},{id:"generator",label:"⚡ Generator"},{id:"mock",label:"📝 Mock"}].map(tab=>(
          <button key={tab.id} onClick={()=>setPage(tab.id)} style={{padding:"6px 12px",margin:"6px 0",borderRadius:DS.radius.sm,border:"none",background:page===tab.id?DS.accent.amberDim:"transparent",cursor:"pointer",color:page===tab.id?DS.accent.amber:DS.text.muted,fontWeight:page===tab.id?800:500,fontSize:12,transition:DS.tr,whiteSpace:"nowrap"}}>
            {tab.label}
          </button>
        ))}
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:8,padding:'0 4px'}}>
          {mode==='sprint'&&(
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <div style={{width:80,height:5,background:DS.bg.elevated,borderRadius:3,overflow:'hidden'}}>
                <div style={{height:'100%',background:DS.accent.amber,width:`${Math.min(100,Math.round(((xp-(getLevel(xp).min))/((LEVELS.find(l=>l.min>xp)?.min||xp+1)-(getLevel(xp).min)))*100))}%`,transition:'width 0.6s ease',borderRadius:3}}/>
              </div>
              <div style={{fontSize:11,color:DS.accent.amber,fontWeight:800}}>{xp} XP</div>
            </div>
          )}
          {(()=>{const p=lsGet('lumora_profile',{});return p.name?(
            <div style={{fontSize:12,color:DS.text.secondary,fontWeight:600,whiteSpace:'nowrap',maxWidth:90,overflow:'hidden',textOverflow:'ellipsis'}}>Hi {p.name.split(' ')[0]}</div>
          ):null;})()}
          <button onClick={toggleSound} title={soundOn?'Mute sounds':'Enable sounds'} style={{background:'none',border:`1px solid ${DS.border}`,borderRadius:DS.radius.sm,padding:'4px 7px',fontSize:13,cursor:'pointer',color:DS.text.muted,lineHeight:1}}>{soundOn?'🔊':'🔇'}</button>
          <StudyModeToggle mode={mode} setMode={setMode}/>
          <button onClick={()=>setShowSettings(true)} title="Account settings" style={{background:'none',border:`1px solid ${DS.border}`,borderRadius:DS.radius.sm,padding:'4px 7px',fontSize:14,cursor:'pointer',color:DS.text.muted,lineHeight:1}}>⚙️</button>
        </div>
        {showSettings&&<SettingsPanel onClose={()=>setShowSettings(false)} onLogout={handleLogout}/>}
      </div>
      {page==="platform"&&<Platform onXP={awardXP} xpV={xpV} mode={mode} onOpenDaily={()=>setShowDailyModal(true)}/>}
      {page==="generator"&&<Generator/>}
      {page==="mock"&&<MockExam onXP={awardXP} mode={mode}/>}
    </div>
  );
}

// ═══ QCARD (Platform static questions — with SM-2 + AI marking) ═══════════
function QCard({q,idx,topicId,onAnswered,onXP,isAI=false}){
  const [open,setOpen]=useState(false);
  const [answered,setAnswered]=useState(null);
  const [working,setWorking]=useState('');
  const [aiResult,setAiResult]=useState(null);
  const [aiLoading,setAiLoading]=useState(false);
  const qid=`${topicId}:${idx}`;
  const d=DIFF[q.diff]||DIFF.Mid;

  const handleAnswer=(correct)=>{
    setAnswered(correct?'right':'wrong');
    if(!isAI)sm2Update(qid,correct?4:1);
    recordPerf(topicId,correct);
    if(onXP)onXP(correct?35:10);
    if(onAnswered)onAnswered();
  };

  const handleAI=async()=>{
    setAiLoading(true);setAiResult(null);
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
            ?<span style={{background:'rgba(155,89,182,0.15)',color:'#9B59B6',fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:5,border:'1px solid rgba(155,89,182,0.3)',flexShrink:0}}>✨ AI</span>
            :<span style={{width:24,height:24,borderRadius:'50%',background:DS.bg.elevated,color:DS.accent.amber,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:11,flexShrink:0}}>{idx+1}</span>
          }
          <span style={{background:d.bg,color:d.c,fontSize:11,fontWeight:800,padding:'2px 8px',borderRadius:6}}>{q.diff}</span>
          <span style={{fontSize:11,color:DS.text.muted,fontWeight:600}}>[{q.marks} mark{q.marks>1?'s':''}]</span>
          {answered&&<span style={{fontSize:11,fontWeight:800,color:answered==='right'?DS.accent.teal:DS.accent.red}}>{answered==='right'?'✓ Got it':'✗ Wrong'}</span>}
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
            <div style={{fontSize:10,fontWeight:800,color:DS.accent.teal}}>💡 Examiner Insight</div>
            <p style={{margin:'4px 0 0',fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{q.insight}</p>
          </div>}

          {!answered&&(
            <div style={{marginTop:14}}>
              <div style={{fontSize:11,fontWeight:700,color:DS.text.secondary,marginBottom:8}}>After checking the mark scheme, how did you do?</div>
              <div style={{display:'flex',gap:8}}>
                <button onClick={()=>handleAnswer(true)} style={{flex:1,padding:9,borderRadius:DS.radius.sm,border:'none',background:DS.accent.teal,color:DS.bg.base,fontWeight:800,fontSize:12,cursor:'pointer'}}>✓ Got It</button>
                <button onClick={()=>handleAnswer(false)} style={{flex:1,padding:9,borderRadius:DS.radius.sm,border:'none',background:DS.accent.red,color:'#fff',fontWeight:800,fontSize:12,cursor:'pointer'}}>✗ Wrong</button>
              </div>
            </div>
          )}

          {working.trim()&&(
            <div style={{marginTop:12}}>
              <button onClick={handleAI} disabled={aiLoading} style={{width:'100%',padding:9,borderRadius:DS.radius.sm,border:`1.5px solid ${DS.borderHi}`,background:aiLoading?DS.bg.overlay:DS.bg.surface,color:aiLoading?DS.text.muted:DS.accent.amber,fontWeight:800,fontSize:12,cursor:aiLoading?'not-allowed':'pointer',transition:DS.tr}}>
                {aiLoading?'🤖 Marking your working...':'🤖 Get AI Feedback on My Working'}
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
                  <SocraticChat question={q.q} ms={q.ms} aiResult={aiResult} maxMarks={q.marks}/>
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
function TopicPage({topic,moduleColor,moduleLabel,onAnswered,onXP}){
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
  const boardColors={AQA:{bd:'#1B2A4A',c:'#7B9FC4'},Edexcel:{bd:'#C0392B',c:'#E07B6A'},OCR:{bd:'#0D6E72',c:'#00C9B1'}};
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

  const Divider=({label,color})=>(
    <div style={{display:'flex',alignItems:'center',gap:8,margin:'4px 0 12px'}}>
      <div style={{fontSize:9,fontWeight:800,color:color||DS.text.muted,textTransform:'uppercase',letterSpacing:1.5,whiteSpace:'nowrap'}}>{label}</div>
      <div style={{flex:1,height:1,background:DS.border}}/>
    </div>
  );

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
              ?<><div style={{width:14,height:14,border:'2px solid rgba(155,89,182,0.25)',borderTopColor:'#9B59B6',borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/>Generating questions…</>
              :<>✨ Generate 3 More Questions{aiQs.length>0?` (${aiQs.length} generated so far)`:''}</>
            }
          </button>
          {!hasKey&&<div style={{textAlign:'center',fontSize:11,color:DS.text.muted,marginTop:6}}>Add VITE_ANTHROPIC_API_KEY to .env.local to enable AI generation</div>}
        </div>
      )}

      {tab==="boards"&&Object.entries(topic.boards).map(([b,txt])=>{
        const bc=boardColors[b]||{bd:DS.border,c:DS.text.secondary};
        return<div key={b} style={{background:DS.bg.elevated,borderLeft:`3px solid ${bc.bd}`,borderRadius:DS.radius.md,padding:'14px 18px',marginBottom:10,border:`1px solid ${DS.border}`}}>
          <span style={{background:bc.bd,color:'#fff',fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:4,letterSpacing:1,display:'inline-block',marginBottom:8}}>{b}</span>
          <p style={{margin:0,fontSize:13,lineHeight:1.6,color:DS.text.secondary}}>{txt}</p>
        </div>;
      })}
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
            <div style={{fontSize:9,fontWeight:800,color:DS.accent.amber,textTransform:'uppercase',letterSpacing:1.5,marginBottom:8}}>✨ AI-Powered</div>
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
                  <div style={{fontSize:32,marginBottom:12}}>🎯</div>
                  <p style={{fontSize:14,color:DS.text.secondary,marginBottom:20}}>AI generates 4 multiple-choice questions — pick the right answer and see why</p>
                  <button onClick={handleLoadMCQ} disabled={!hasKey} style={{padding:'10px 28px',borderRadius:DS.radius.md,border:'none',background:DS.accent.teal,color:DS.bg.base,fontWeight:800,fontSize:13,cursor:hasKey?'pointer':'not-allowed',opacity:hasKey?1:0.5}}>Generate Questions</button>
                  {mcqError&&<div style={{marginTop:12,color:DS.accent.red,fontSize:12}}>{mcqError}</div>}
                  {!hasKey&&<div style={{marginTop:8,fontSize:11,color:DS.text.muted}}>Requires VITE_ANTHROPIC_API_KEY</div>}
                </div>
              )}
              {mcqLoading&&<div style={{textAlign:'center',padding:40,color:DS.text.secondary}}><div style={{width:32,height:32,border:`3px solid ${DS.accent.tealDim}`,borderTopColor:DS.accent.teal,borderRadius:'50%',animation:'spin 0.8s linear infinite',margin:'0 auto 12px'}}/>Generating questions…</div>}
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
                            {opt}{revealed&&isCorrect?' ✓':revealed&&isSelected?' ✗':''}
                          </button>
                        );
                      })}
                    </div>
                    {selected&&<div style={{marginTop:12,background:DS.bg.surface,borderLeft:`3px solid ${selected===q.answer?DS.accent.teal:DS.accent.amber}`,padding:'10px 14px',borderRadius:`0 ${DS.radius.sm}px ${DS.radius.sm}px 0`}}>
                      <div style={{fontSize:10,fontWeight:800,color:selected===q.answer?DS.accent.teal:DS.accent.amber,marginBottom:4}}>{selected===q.answer?'✓ CORRECT':'✗ NOT QUITE — EXPLANATION'}</div>
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
              {stepsLoading&&<div style={{textAlign:'center',padding:40,color:DS.text.secondary}}><div style={{width:32,height:32,border:`3px solid ${DS.accent.amberDim}`,borderTopColor:DS.accent.amber,borderRadius:'50%',animation:'spin 0.8s linear infinite',margin:'0 auto 12px'}}/>Building worked example…</div>}
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
                  {explainLoading?'Checking your understanding…':'✓ Check My Understanding'}
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
                  {explainResult.tip&&<div style={{background:DS.bg.surface,borderRadius:DS.radius.sm,padding:'10px 14px'}}><div style={{fontSize:9,fontWeight:800,color:DS.text.muted,marginBottom:3}}>💡 TIP FOR NEXT TIME</div><p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{explainResult.tip}</p></div>}
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
              {vizLoading&&<div style={{textAlign:'center',padding:40,color:DS.text.secondary}}><div style={{width:32,height:32,border:`3px solid ${DS.accent.amberDim}`,borderTopColor:DS.accent.amber,borderRadius:'50%',animation:'spin 0.8s linear infinite',margin:'0 auto 12px'}}/>Drawing diagram…</div>}
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
                  {vizData.insight&&<div style={{background:DS.accent.amberDim,border:`1px solid ${DS.accent.amber}33`,borderRadius:DS.radius.md,padding:'12px 16px'}}><span style={{fontSize:10,fontWeight:800,color:DS.accent.amber}}>💡 KEY INSIGHT  </span><span style={{fontSize:13,color:DS.text.secondary}}>{vizData.insight}</span></div>}
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
              {errorHuntLoading&&<div style={{textAlign:'center',padding:40,color:DS.text.secondary}}><div style={{width:32,height:32,border:'3px solid rgba(155,89,182,0.2)',borderTopColor:'#9B59B6',borderRadius:'50%',animation:'spin 0.8s linear infinite',margin:'0 auto 12px'}}/>Planting mistakes…</div>}
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
                            {errorHuntRevealed&&!isActuallyWrong&&<div style={{marginTop:6,fontSize:11,color:DS.accent.teal,fontWeight:700}}>✓ This step is correct</div>}
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
                        {errorHuntData.tip&&<div style={{background:'rgba(155,89,182,0.08)',border:'1px solid rgba(155,89,182,0.25)',borderRadius:DS.radius.md,padding:'12px 16px',marginTop:12}}><div style={{fontSize:10,fontWeight:800,color:'#9B59B6',marginBottom:4}}>💡 EXAMINER TIP</div><p style={{margin:0,fontSize:13,color:DS.text.secondary,lineHeight:1.5}}>{errorHuntData.tip}</p></div>}
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
              {realWorldLoading&&<div style={{textAlign:'center',padding:40,color:DS.text.secondary}}><div style={{width:32,height:32,border:`3px solid ${DS.accent.tealDim}`,borderTopColor:DS.accent.teal,borderRadius:'50%',animation:'spin 0.8s linear infinite',margin:'0 auto 12px'}}/>Building scenario…</div>}
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

// ═══ FOCUS TODAY (DUE FOR REVIEW) ════════════════════════════════════════════
function DueForReview({onNavigate,version}){
  const dueIds=getDueIds();
  const dueQs=dueIds.map(id=>QUESTION_MAP[id]).filter(Boolean);
  const urgent=dueQs.length>3;
  if(!dueQs.length)return(
    <div style={{background:DS.bg.surface,borderLeft:`3px solid ${DS.accent.teal}`,borderRadius:DS.radius.md,padding:'12px 18px',marginBottom:16,border:`1px solid ${DS.border}`}}>
      <div style={{fontSize:12,fontWeight:800,color:DS.accent.teal}}>✓ No reviews due today — you're all caught up!</div>
    </div>
  );
  return(
    <div style={{background:DS.bg.surface,borderLeft:`3px solid ${DS.accent.amber}`,borderRadius:DS.radius.md,padding:'14px 18px',marginBottom:16,border:`1px solid ${DS.border}`,animation:urgent?'pulseAmber 2s ease-in-out infinite':undefined}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
        <div style={{fontSize:12,fontWeight:800,color:DS.accent.amber}}>Focus Today — {dueQs.length} due</div>
        <div style={{fontSize:10,color:DS.text.muted}}>Memory decay active</div>
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
  );
}

// ═══ WEAKNESS HEATMAP ════════════════════════════════════════════════════════
function WeaknessHeatmap({onNavigate,version}){
  const perf=lsGet('gcse_perf',{});
  const allTopics=MODULES.flatMap(m=>m.topics.map(t=>({...t,moduleLabel:m.label,moduleColor:m.color})));
  return(
    <div style={{background:DS.bg.surface,borderRadius:DS.radius.md,border:`1px solid ${DS.border}`,padding:'16px 18px',marginBottom:16}}>
      <div style={{fontSize:10,fontWeight:800,color:DS.text.secondary,textTransform:'uppercase',letterSpacing:1.5,marginBottom:12}}>Performance Analytics</div>
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
    </div>
  );
}

// ═══ PLATFORM ════════════════════════════════════════════════════════════════
export function Platform({onXP=()=>{},xpV=0,mode='sprint',onOpenDaily=()=>{}}){
  const [modId,setModId]=useState(null);
  const [topicId,setTopicId]=useState(null);
  const [search,setSearch]=useState("");
  const [version,setVersion]=useState(0);
  const bump=useCallback(()=>setVersion(v=>v+1),[]);
  const xp=getXP();

  const mod=MODULES.find(m=>m.id===modId);
  const topic=mod?.topics.find(t=>t.id===topicId);
  const totalQ=MODULES.reduce((s,m)=>s+m.topics.reduce((ss,t)=>ss+t.questions.length,0),0);
  const totalT=MODULES.reduce((s,m)=>s+m.topics.length,0);

  const handleAnswered=useCallback(()=>{
    setVersion(v=>v+1);
    if(topic){
      const flagKey=`lumora_tc_${topic.id}`;
      if(!lsGet(flagKey,false)){
        const srData=lsGet('gcse_sr',{});
        const allAnswered=topic.questions.every((_,i)=>srData[`${topic.id}:${i}`]);
        if(allAnswered){lsSet(flagKey,true);onXP(50);}
      }
    }
  },[topic,onXP]);
  const searchRes=search.trim().length>1?MODULES.flatMap(m=>m.topics.filter(t=>t.title.toLowerCase().includes(search.toLowerCase())).map(t=>({...t,mod:m}))):[];

  const navigateToTopic=(tid)=>{
    const m=findModForTopic(tid);
    if(m){setModId(m.id);setTopicId(tid);}
  };

  if(topic)return(
    <div style={{fontFamily:"'Segoe UI',sans-serif",maxWidth:680,margin:"0 auto",padding:16,background:DS.bg.base,minHeight:"100vh"}}>
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
    <div style={{fontFamily:"'Segoe UI',sans-serif",maxWidth:680,margin:"0 auto",padding:16,background:DS.bg.base,minHeight:"100vh"}}>
      <div style={{background:DS.bg.elevated,borderRadius:DS.radius.lg,padding:"22px",marginBottom:14,position:"relative",overflow:"hidden",border:`1px solid ${DS.border}`,borderLeft:`4px solid ${mod.color}`}}>
        <div style={{position:"absolute",right:-20,top:-20,fontSize:110,opacity:0.05,fontWeight:900}}>{mod.icon}</div>
        <button onClick={()=>setModId(null)} style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.sm,padding:"5px 12px",color:DS.text.secondary,fontSize:12,fontWeight:700,cursor:"pointer",marginBottom:10}}>← Back</button>
        <div style={{fontSize:22,fontWeight:900,color:DS.text.primary}}>{mod.label}</div>
        <div style={{fontSize:12,color:DS.text.muted,marginTop:4}}>{mod.topics.length} topics</div>
      </div>
      <div style={{display:"grid",gap:8}}>
        {mod.topics.map(t=>(
          <button key={t.id} onClick={()=>setTopicId(t.id)} style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:"16px 18px",textAlign:"left",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",transition:DS.tr}} onMouseEnter={e=>e.currentTarget.style.borderColor=mod.color} onMouseLeave={e=>e.currentTarget.style.borderColor=DS.border}>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:DS.text.primary,marginBottom:4}}>{t.title}</div>
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

      {/* Personalised Hero */}
      <PersonalisedHero onNavigate={navigateToTopic}/>

      {/* Daily Challenge widget */}
      {(()=>{
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
            <span style={{fontSize:22}}>📅</span>
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
      <div style={{position:"relative",marginBottom:14}}>
        <span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",fontSize:15,color:DS.text.muted}}>⌕</span>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search topics..." style={{width:"100%",padding:"10px 16px 10px 40px",borderRadius:DS.radius.md,border:`1.5px solid ${DS.border}`,fontSize:14,background:DS.bg.surface,outline:"none",boxSizing:"border-box",color:DS.text.primary}} onFocus={e=>e.target.style.borderColor=DS.accent.amber} onBlur={e=>e.target.style.borderColor=DS.border}/>
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
      <DueForReview key={`due-${version}`} onNavigate={navigateToTopic} version={version}/>

      {/* Weekly Goal */}
      <WeeklyGoalBar/>

      {/* Module Mastery Grid */}
      <div style={{fontSize:10,fontWeight:800,color:DS.text.muted,textTransform:"uppercase",letterSpacing:1.5,marginBottom:10}}>Module Mastery</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:16}}>
        {MODULES.map(m=>{
          const mPerf=m.topics.flatMap(t=>{const p=perf[t.id];return p&&p.total>0?[p.correct/p.total]:[];});
          const ratio=mPerf.length>0?mPerf.reduce((s,v)=>s+v,0)/mPerf.length:0;
          const attempted=mPerf.length;
          return(
            <button key={m.id} onClick={()=>setModId(m.id)} style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.md,padding:"12px",textAlign:"left",cursor:"pointer",transition:DS.tr,display:"flex",flexDirection:"column",gap:8}} onMouseEnter={e=>e.currentTarget.style.borderColor=m.color} onMouseLeave={e=>e.currentTarget.style.borderColor=DS.border}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <MasteryRing ratio={attempted>0?ratio:0} color={m.color} size={40} stroke={3}/>
                <div>
                  <div style={{fontSize:12,fontWeight:800,color:DS.text.primary,lineHeight:1.2}}>{m.label}</div>
                  <div style={{fontSize:10,color:DS.text.muted}}>{m.topics.length} topics</div>
                </div>
              </div>
              <div style={{fontSize:10,color:attempted>0?m.color:DS.text.muted,fontWeight:600}}>{attempted>0?`${Math.round(ratio*100)}% avg`:'Not started'}</div>
            </button>
          );
        })}
      </div>

      {/* Analytics */}
      <WeaknessHeatmap key={`heat-${version}`} onNavigate={navigateToTopic} version={version}/>

      {/* Stats */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:14}}>
        {[{l:"Modules",v:MODULES.length,c:DS.accent.amber},{l:"Topics",v:totalT,c:DS.accent.teal},{l:"Questions",v:totalQ,c:DS.accent.amber}].map(s=>(
          <div key={s.l} style={{background:DS.bg.surface,borderRadius:DS.radius.sm,padding:"10px",textAlign:"center",border:`1px solid ${DS.border}`}}>
            <div style={{fontSize:20,fontWeight:900,color:s.c}}>{s.v}</div>
            <div style={{fontSize:10,color:DS.text.muted,fontWeight:600,marginTop:1}}>{s.l}</div>
          </div>
        ))}
      </div>
      <div style={{fontSize:10,fontWeight:800,color:DS.text.muted,textTransform:"uppercase",letterSpacing:1.5,marginBottom:10}}>All Modules</div>
      <div style={{display:"grid",gap:8}}>
        {MODULES.map(m=>(
          <button key={m.id} onClick={()=>setModId(m.id)} style={{background:DS.bg.surface,border:`1px solid ${DS.border}`,borderRadius:DS.radius.lg,padding:"16px",textAlign:"left",cursor:"pointer",position:"relative",overflow:"hidden",transition:DS.tr}} onMouseEnter={e=>e.currentTarget.style.borderColor=m.color} onMouseLeave={e=>e.currentTarget.style.borderColor=DS.border}>
            <div style={{position:"absolute",right:-10,top:-10,fontSize:65,opacity:0.04,fontWeight:900}}>{m.icon}</div>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <div style={{width:44,height:44,borderRadius:DS.radius.md,background:m.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,color:"#fff",flexShrink:0}}>{m.icon}</div>
              <div style={{flex:1}}>
                <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:10,fontWeight:800,color:m.color,letterSpacing:1}}>{m.code}</span><span style={{fontSize:11,color:DS.text.muted}}>{m.topics.length} topics →</span></div>
                <div style={{fontSize:14,fontWeight:800,color:DS.text.primary,marginTop:2}}>{m.label}</div>
                <div style={{display:"flex",gap:4,marginTop:6,flexWrap:"wrap"}}>
                  {m.topics.map(t=><span key={t.id} style={{fontSize:9,color:DS.text.muted,background:DS.bg.elevated,padding:"2px 5px",borderRadius:3,border:`1px solid ${DS.border}`}}>{t.title}</span>)}
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>
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
            <div style={{fontSize:10,fontWeight:800,color:DS.accent.teal}}>💡 Examiner Insight</div>
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
                {aiLoading?'🤖 Marking...':'🤖 Get AI Feedback on My Working'}
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
    if(!xpAwarded.current){xpAwarded.current=true;onXP(100);}
    setSubmitted(true);
  },[onXP]);

  useEffect(()=>{
    if(!started||submitted)return;
    if(timeLeft<=0){handleSubmit();return;}
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
        <div style={{width:64,height:64,borderRadius:'50%',background:DS.accent.amberDim,border:`2px solid ${DS.accent.amber}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:28,margin:'0 auto 16px'}}>📝</div>
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
      <button onClick={()=>setStarted(true)} style={{width:'100%',padding:16,borderRadius:DS.radius.md,border:'none',background:DS.accent.amber,color:DS.bg.deep,fontSize:15,fontWeight:900,cursor:'pointer',boxShadow:`0 4px 18px ${DS.accent.amberDim}`,transition:DS.tr}}>
        Start Exam
      </button>
    </div>
  );

  if(submitted)return(
    <div style={{maxWidth:680,margin:'0 auto',padding:20,fontFamily:"'Inter','Segoe UI',sans-serif",background:mode==='deep'?DS.bg.deep:DS.bg.base,minHeight:'100vh'}}>
      <div style={{background:DS.bg.surface,borderRadius:DS.radius.xl,padding:28,textAlign:'center',marginBottom:16,border:`1px solid ${DS.border}`,boxShadow:DS.shadow,position:'relative',overflow:'hidden'}}>
        <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:`linear-gradient(90deg,${DS.accent.amber},${DS.accent.teal})`,opacity:0.7}}/>
        <div style={{width:72,height:72,borderRadius:'50%',background:pct>=70?DS.accent.amberDim:pct>=50?DS.accent.tealDim:DS.bg.elevated,border:`2px solid ${pct>=70?DS.accent.amber:pct>=50?DS.accent.teal:DS.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:32,margin:'0 auto 16px'}}>{pct>=70?'🏆':pct>=50?'📊':'📚'}</div>
        <div style={{fontSize:18,fontWeight:900,color:DS.text.primary,marginBottom:4}}>Exam Complete</div>
        {markedCount>0?(
          <>
            <div style={{fontSize:52,fontWeight:900,color:DS.accent.amber,lineHeight:1.1}}>{earnedMarks}<span style={{fontSize:24,color:DS.text.muted}}>/{totalMarks}</span></div>
            <div style={{fontSize:13,color:DS.text.secondary,marginTop:6}}>{pct}% · {markedCount}/{questions.length} questions self-marked</div>
          </>
        ):(
          <div style={{fontSize:13,color:DS.text.secondary,marginTop:8}}>Reveal each mark scheme below and self-mark to see your score</div>
        )}
      </div>
      {questions.map((q,i)=>(
        <MockQCard key={q.qid} q={q} idx={i} working={workings[i]||''} selfMark={selfMarks[i]} onSelfMark={m=>setSelfMarks(s=>({...s,[i]:m}))}/>
      ))}
    </div>
  );

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
        <div style={{display:"grid",gridTemplateColumns:"260px 1fr",gap:20,alignItems:"start"}}>
          {/* Sidebar */}
          <div style={{background:DS.bg.surface,borderRadius:DS.radius.lg,border:`1px solid ${DS.border}`,overflow:"hidden",position:"sticky",top:60}}>
            <div style={{padding:"14px 16px",borderBottom:`1px solid ${DS.border}`}}>
              <div style={{fontSize:9,fontWeight:800,color:DS.text.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Exam Board</div>
              <div style={{display:"flex",gap:5}}>
                {["AQA","Edexcel","OCR"].map(b=><button key={b} onClick={()=>setCfg(c=>({...c,board:b}))} style={{flex:1,padding:"8px 0",borderRadius:DS.radius.sm,border:`1.5px solid ${cfg.board===b?BCOLORS[b]:DS.border}`,background:cfg.board===b?`${BCOLORS[b]}22`:DS.bg.elevated,color:cfg.board===b?BCOLORS[b]:DS.text.secondary,fontWeight:800,fontSize:11,cursor:"pointer",transition:DS.tr}}>{b}</button>)}
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
              {loading?(<><div style={{width:16,height:16,border:`2px solid ${DS.border}`,borderTopColor:DS.text.primary,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>Generating {cfg.count} question{cfg.count>1?"s":""}...</>)
                :`Generate ${cfg.count} ${cfg.topicLabel} — ${cfg.board} ${cfg.tier} ${cfg.diff}`}
            </button>
            {err&&<div style={{background:DS.accent.redDim,border:`1.5px solid ${DS.accent.red}`,borderRadius:DS.radius.md,padding:"12px 16px",marginBottom:14,color:DS.accent.red,fontSize:13}}>{err}</div>}
            {loading&&!qs.length&&<div style={{textAlign:"center",padding:"60px 20px",color:DS.text.muted}}>
              <div style={{fontSize:36,marginBottom:12,color:DS.accent.amber}}>⚡</div>
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
