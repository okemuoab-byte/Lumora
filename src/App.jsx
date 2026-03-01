import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ═══ STORAGE & SM-2 ══════════════════════════════════════════════════════════
function lsGet(k,d){try{const v=localStorage.getItem(k);return v!=null?JSON.parse(v):d;}catch{return d;}}
function lsSet(k,v){localStorage.setItem(k,JSON.stringify(v));}

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
}
function heatColor(r){
  if(r===null)return{bg:'#f0f0f0',c:'#999'};
  if(r>=0.7)return{bg:'#d4edda',c:'#155724'};
  if(r>=0.4)return{bg:'#fff3cd',c:'#856404'};
  return{bg:'#f8d7da',c:'#721c24'};
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

async function aiSocratic(question,ms,aiResult,chatHistory){
  const key=import.meta.env.VITE_ANTHROPIC_API_KEY;
  if(!key)throw new Error('Add VITE_ANTHROPIC_API_KEY to .env.local');
  const gotFull=aiResult.marksEarned>=(aiResult.maxMarks??aiResult.totalMarks??999);
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

// ═══ SOCRATIC CHAT ═══════════════════════════════════════════════════════════
function SocraticChat({question,ms,aiResult}){
  const [messages,setMessages]=useState([]);
  const [input,setInput]=useState('');
  const [loading,setLoading]=useState(false);
  const bottomRef=useRef(null);

  useEffect(()=>{
    setLoading(true);
    aiSocratic(question,ms,aiResult,[])
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
    try{const text=await aiSocratic(question,ms,aiResult,updated);setMessages(m=>[...m,{from:'tutor',text}]);}
    catch(e){setMessages(m=>[...m,{from:'tutor',text:'Error: '+e.message}]);}
    setLoading(false);
  };

  return(
    <div style={{marginTop:14,borderTop:'1.5px dashed #d8d0ff',paddingTop:12}}>
      <div style={{fontSize:11,fontWeight:800,color:'#7B68EE',textTransform:'uppercase',letterSpacing:1,marginBottom:10}}>💬 Socratic Tutor — Keep going until you get it</div>
      <div style={{maxHeight:260,overflowY:'auto',display:'flex',flexDirection:'column',gap:8,marginBottom:10}}>
        {loading&&messages.length===0&&(
          <div style={{display:'flex',gap:8,alignItems:'flex-start'}}>
            <div style={{width:26,height:26,borderRadius:'50%',background:'#7B68EE',color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,flexShrink:0}}>🧑‍🏫</div>
            <div style={{background:'#f0edff',borderRadius:'0 10px 10px 10px',padding:'8px 12px',fontSize:13,color:'#888',fontStyle:'italic'}}>Preparing your question…</div>
          </div>
        )}
        {messages.map((m,i)=>(
          <div key={i} style={{display:'flex',gap:8,alignItems:'flex-start',flexDirection:m.from==='tutor'?'row':'row-reverse'}}>
            <div style={{width:26,height:26,borderRadius:'50%',background:m.from==='tutor'?'#7B68EE':'#1B2A4A',color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,flexShrink:0}}>{m.from==='tutor'?'🧑‍🏫':'✏️'}</div>
            <div style={{background:m.from==='tutor'?'#f0edff':'#1B2A4A',border:`1.5px solid ${m.from==='tutor'?'#d8d0ff':'#1B2A4A'}`,borderRadius:m.from==='tutor'?'0 10px 10px 10px':'10px 0 10px 10px',padding:'8px 12px',fontSize:13,color:m.from==='tutor'?'#2d2070':'#fff',maxWidth:'82%',lineHeight:1.55}}>
              {m.text}
            </div>
          </div>
        ))}
        {loading&&messages.length>0&&(
          <div style={{display:'flex',gap:8,alignItems:'flex-start'}}>
            <div style={{width:26,height:26,borderRadius:'50%',background:'#7B68EE',color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,flexShrink:0}}>🧑‍🏫</div>
            <div style={{background:'#f0edff',borderRadius:'0 10px 10px 10px',padding:'8px 12px',fontSize:13,color:'#888',fontStyle:'italic'}}>Thinking…</div>
          </div>
        )}
        <div ref={bottomRef}/>
      </div>
      <div style={{display:'flex',gap:8}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&handleSend()} placeholder="Type your response and press Enter…" disabled={loading} style={{flex:1,padding:'8px 12px',borderRadius:8,border:'1.5px solid #d8d0ff',fontSize:13,fontFamily:'inherit',outline:'none',background:loading?'#f8f8f8':'#fff'}}/>
        <button onClick={handleSend} disabled={loading||!input.trim()} style={{padding:'8px 14px',borderRadius:8,border:'none',background:loading||!input.trim()?'#ccc':'#7B68EE',color:'#fff',fontWeight:800,fontSize:14,cursor:loading||!input.trim()?'not-allowed':'pointer'}}>→</button>
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
const DIFF={Starter:{c:"#27AE60",bg:"#E9F7EF"},Mid:{c:"#E8B84B",bg:"#FEF9E7"},Killer:{c:"#E74C3C",bg:"#FDECEA"}};
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
    `}</style>
  );
}

// ═══ CELEBRATION OVERLAY ══════════════════════════════════════════════════════
function Celebration({data,onDone}){
  useEffect(()=>{const t=setTimeout(onDone,2400);return()=>clearTimeout(t);},[]);
  if(!data)return null;
  return(
    <div style={{position:'fixed',inset:0,zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',pointerEvents:'none',animation:'celebFade 2.4s forwards'}}>
      <div style={{background:'linear-gradient(135deg,#1B2A4A,#0D6E72)',borderRadius:20,padding:'28px 40px',textAlign:'center',boxShadow:'0 8px 40px rgba(0,0,0,0.4)',animation:'celebPop 0.5s ease-out'}}>
        <div style={{fontSize:56,marginBottom:8}}>{data.icon}</div>
        <div style={{fontSize:22,fontWeight:900,color:'#D4A017',marginBottom:6}}>{data.title}</div>
        <div style={{fontSize:14,color:'rgba(255,255,255,0.85)'}}>{data.body}</div>
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
    <div style={{background:'#fff',borderRadius:14,padding:'14px 18px',marginBottom:16,border:'1.5px solid #e8e8e8',boxShadow:'0 2px 8px rgba(0,0,0,0.04)'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:28}}>{lvl.icon}</span>
          <div>
            <div style={{fontSize:13,fontWeight:800,color:'#1B2A4A'}}>{lvl.name} · {xp} XP</div>
            <div style={{fontSize:10,color:'#888'}}>{next?`${next.min-xp} XP to ${next.name}`:'Max level — Legend! 🏆'}</div>
          </div>
        </div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:22}}>🔥</div>
          <div style={{fontSize:11,fontWeight:800,color:'#1B2A4A'}}>{streak.current} day streak</div>
          {streak.freezes>0&&<div style={{fontSize:9,color:'#888'}}>❄️ {streak.freezes} freeze{streak.freezes!==1?'s':''}</div>}
        </div>
      </div>
      <div style={{background:'#f0f0f0',borderRadius:6,height:8,overflow:'hidden'}}>
        <div style={{height:'100%',borderRadius:6,background:`linear-gradient(90deg,${lvl.color},${next?.color||lvl.color})`,width:`${pct}%`,transition:'width 0.6s ease'}}/>
      </div>
      <div style={{fontSize:10,color:'#aaa',marginTop:4,textAlign:'right'}}>{pct}% to {next?.name||'Max'}</div>
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
    <div style={{fontFamily:"'Segoe UI',sans-serif",minHeight:'100vh',background:'linear-gradient(135deg,#1B2A4A 0%,#0D3D3D 100%)',display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{width:'100%',maxWidth:460,background:'#fff',borderRadius:20,overflow:'hidden',boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}}>
        <div style={{height:4,background:'#f0f0f0'}}><div style={{height:'100%',background:'#D4A017',width:`${(step/5)*100}%`,transition:'width 0.4s ease'}}/></div>
        <div style={{padding:'28px 28px 24px'}}>
          <div style={{fontSize:10,fontWeight:800,color:'#D4A017',letterSpacing:2,textTransform:'uppercase',marginBottom:16}}>Step {step} of 5</div>
          {step===1&&(
            <div style={{animation:'fadeInUp 0.3s ease'}}>
              <div style={{fontSize:36,marginBottom:8}}>👋</div>
              <div style={{fontSize:22,fontWeight:900,color:'#1B2A4A',marginBottom:6}}>What's your name?</div>
              <div style={{fontSize:13,color:'#888',marginBottom:20}}>Let's personalise your experience</div>
              <input value={profile.name} onChange={e=>update('name',e.target.value)} placeholder="e.g. Alex" autoFocus style={{width:'100%',padding:'14px 16px',borderRadius:10,border:'1.5px solid #e0e0e0',fontSize:16,fontFamily:'inherit',outline:'none',boxSizing:'border-box',color:'#1B2A4A'}} onFocus={e=>e.target.style.borderColor='#D4A017'} onBlur={e=>e.target.style.borderColor='#e0e0e0'}/>
            </div>
          )}
          {step===2&&(
            <div style={{animation:'fadeInUp 0.3s ease'}}>
              <div style={{fontSize:36,marginBottom:8}}>📋</div>
              <div style={{fontSize:22,fontWeight:900,color:'#1B2A4A',marginBottom:6}}>Which exam board?</div>
              <div style={{fontSize:13,color:'#888',marginBottom:20}}>We'll highlight board-specific tips for you</div>
              <div style={{display:'grid',gap:10}}>
                {boards.map(b=>(
                  <button key={b} onClick={()=>update('board',b)} style={{padding:'16px 20px',borderRadius:12,border:`2px solid ${profile.board===b?'#1B2A4A':'#e8e8e8'}`,background:profile.board===b?'#1B2A4A':'#fff',color:profile.board===b?'#fff':'#1a1a2e',fontWeight:700,fontSize:14,cursor:'pointer',textAlign:'left',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                    {b}{profile.board===b&&<span>✓</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
          {step===3&&(
            <div style={{animation:'fadeInUp 0.3s ease'}}>
              <div style={{fontSize:36,marginBottom:8}}>🎯</div>
              <div style={{fontSize:22,fontWeight:900,color:'#1B2A4A',marginBottom:6}}>Target grade?</div>
              <div style={{fontSize:13,color:'#888',marginBottom:20}}>Lumora will tune difficulty to your goal</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10}}>
                {grades.map(g=>(
                  <button key={g} onClick={()=>update('grade',g)} style={{padding:'18px 0',borderRadius:12,border:`2px solid ${profile.grade===g?'#D4A017':'#e8e8e8'}`,background:profile.grade===g?'#D4A017':'#fff',color:profile.grade===g?'#1B2A4A':'#555',fontWeight:900,fontSize:22,cursor:'pointer'}}>
                    {g}
                  </button>
                ))}
              </div>
            </div>
          )}
          {step===4&&(
            <div style={{animation:'fadeInUp 0.3s ease'}}>
              <div style={{fontSize:36,marginBottom:8}}>📅</div>
              <div style={{fontSize:22,fontWeight:900,color:'#1B2A4A',marginBottom:6}}>When's your exam?</div>
              <div style={{fontSize:13,color:'#888',marginBottom:20}}>We'll create a revision countdown for you</div>
              <input type="date" value={profile.examDate} onChange={e=>update('examDate',e.target.value)} style={{width:'100%',padding:'14px 16px',borderRadius:10,border:'1.5px solid #e0e0e0',fontSize:16,fontFamily:'inherit',outline:'none',boxSizing:'border-box',color:'#1B2A4A'}}/>
              {weeks!==null&&<div style={{marginTop:12,background:'#f0f8ff',borderRadius:10,padding:'12px 16px',fontSize:13,color:'#1B2A4A',fontWeight:700}}>📆 {weeks} week{weeks!==1?'s':''} to go — let's make every session count</div>}
            </div>
          )}
          {step===5&&(
            <div style={{animation:'fadeInUp 0.3s ease'}}>
              <div style={{fontSize:36,marginBottom:8}}>📊</div>
              <div style={{fontSize:22,fontWeight:900,color:'#1B2A4A',marginBottom:6}}>Your biggest weaknesses?</div>
              <div style={{fontSize:13,color:'#888',marginBottom:16}}>Pick up to 3 topics — we'll prioritise these first</div>
              <div style={{maxHeight:280,overflowY:'auto',display:'grid',gap:6}}>
                {allTopics.map(t=>{
                  const sel=profile.weaknesses.includes(t.id);
                  const dis=!sel&&profile.weaknesses.length>=3;
                  return(
                    <button key={t.id} onClick={()=>!dis&&toggleWeak(t.id)} style={{padding:'10px 14px',borderRadius:10,border:`1.5px solid ${sel?'#1B2A4A':'#e0e0e0'}`,background:sel?'#1B2A4A':'#fff',color:sel?'#fff':'#555',fontWeight:sel?700:400,fontSize:12,cursor:dis?'not-allowed':'pointer',textAlign:'left',opacity:dis?0.4:1,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                      <span>{t.title}</span>{sel&&<span>✓</span>}
                    </button>
                  );
                })}
              </div>
              <div style={{fontSize:11,color:'#888',marginTop:8}}>{profile.weaknesses.length}/3 selected</div>
            </div>
          )}
          <button onClick={handleNext} disabled={!canNext} style={{marginTop:24,width:'100%',padding:'15px 0',borderRadius:12,border:'none',background:canNext?'linear-gradient(135deg,#1B2A4A,#0D6E72)':'#e0e0e0',color:canNext?'#fff':'#aaa',fontWeight:900,fontSize:15,cursor:canNext?'pointer':'not-allowed',transition:'all 0.2s'}}>
            {step<5?'Continue →':`Let's go, ${profile.name}! 🚀`}
          </button>
          {step>1&&<button onClick={()=>setStep(s=>s-1)} style={{marginTop:8,width:'100%',padding:'10px 0',borderRadius:12,border:'none',background:'transparent',color:'#aaa',fontSize:13,cursor:'pointer'}}>← Back</button>}
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
    <div style={{fontFamily:"'Segoe UI',sans-serif",background:'#0D1B2A',minHeight:'100vh'}}>
      {/* Nav */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'16px 24px',borderBottom:'1px solid rgba(255,255,255,0.08)'}}>
        <div style={{fontSize:18,fontWeight:900,color:'#D4A017',letterSpacing:1}}>📐 Lumora</div>
        <button onClick={onStart} style={{padding:'10px 24px',borderRadius:24,border:'none',background:'#D4A017',color:'#1B2A4A',fontWeight:900,fontSize:13,cursor:'pointer'}}>
          {profile?'Continue Learning →':'Start Free'}
        </button>
      </div>
      {/* Hero */}
      <div style={{textAlign:'center',padding:'60px 24px 40px',maxWidth:640,margin:'0 auto'}}>
        {profile&&(
          <div style={{background:'rgba(212,160,23,0.15)',border:'1.5px solid rgba(212,160,23,0.3)',borderRadius:16,padding:'14px 20px',marginBottom:28,display:'inline-block'}}>
            <div style={{fontSize:14,color:'#D4A017',fontWeight:700}}>
              Welcome back, {profile.name}! {lvl.icon} {xp} XP · 🔥 {streak.current} day streak{weeks!==null?` · 📅 ${weeks} weeks to exam`:''}
            </div>
          </div>
        )}
        <div style={{fontSize:48,marginBottom:16}}>🎓</div>
        <h1 style={{fontSize:40,fontWeight:900,color:'#fff',lineHeight:1.1,margin:'0 0 16px'}}>Meet <span style={{color:'#D4A017'}}>Lumora</span></h1>
        <p style={{fontSize:17,color:'rgba(255,255,255,0.7)',lineHeight:1.6,margin:'0 0 32px'}}>The AI tutor that thinks like your best teacher</p>
        <button onClick={onStart} style={{padding:'16px 40px',borderRadius:50,border:'none',background:'linear-gradient(135deg,#D4A017,#E8B84B)',color:'#1B2A4A',fontWeight:900,fontSize:16,cursor:'pointer',boxShadow:'0 8px 32px rgba(212,160,23,0.35)'}}>
          {profile?'Continue Learning →':'Start Free — No credit card needed'}
        </button>
      </div>
      {/* Problem stats */}
      <div style={{background:'rgba(255,255,255,0.04)',padding:'40px 24px'}}>
        <div style={{maxWidth:680,margin:'0 auto'}}>
          <div style={{textAlign:'center',fontSize:12,fontWeight:800,color:'#D4A017',letterSpacing:2,textTransform:'uppercase',marginBottom:24}}>The Problem With Traditional Revision</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14,textAlign:'center'}}>
            {[{stat:'1 in 3',desc:'students underperform in GCSE Maths despite revising'},{stat:'£60/hr',desc:'average private tutor — unaffordable for most families'},{stat:'957K',desc:'young people NEET — often held back by basic Maths'}].map(s=>(
              <div key={s.stat} style={{background:'rgba(255,255,255,0.05)',borderRadius:14,padding:'20px 12px'}}>
                <div style={{fontSize:28,fontWeight:900,color:'#D4A017',marginBottom:8}}>{s.stat}</div>
                <div style={{fontSize:11,color:'rgba(255,255,255,0.6)',lineHeight:1.5}}>{s.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* How it works */}
      <div style={{padding:'48px 24px',maxWidth:640,margin:'0 auto'}}>
        <div style={{textAlign:'center',fontSize:12,fontWeight:800,color:'#D4A017',letterSpacing:2,textTransform:'uppercase',marginBottom:8}}>How It Works</div>
        <div style={{textAlign:'center',fontSize:22,fontWeight:900,color:'#fff',marginBottom:28}}>Four steps from confused to confident</div>
        <div style={{display:'grid',gap:14}}>
          {[{n:1,icon:'📝',t:'Practice',d:'Work through exam-style questions at 3 difficulty levels across all GCSE Maths topics'},{n:2,icon:'🤖',t:'AI Marks Your Working',d:'Claude analyses your method step-by-step, just like a real examiner would'},{n:3,icon:'📊',t:'Progress Tracked',d:'Spaced repetition schedules your revision. Heatmaps show exactly where to focus next'},{n:4,icon:'🏆',t:'Level Up',d:'Earn XP, build streaks, and unlock levels as you improve. Revision that actually feels rewarding'}].map(s=>(
            <div key={s.n} style={{display:'flex',gap:16,alignItems:'flex-start',background:'rgba(255,255,255,0.04)',borderRadius:14,padding:'18px 20px'}}>
              <div style={{width:40,height:40,borderRadius:10,background:'#D4A017',display:'flex',alignItems:'center',justifyContent:'center',fontSize:20,flexShrink:0}}>{s.icon}</div>
              <div><div style={{fontSize:15,fontWeight:800,color:'#fff',marginBottom:4}}>{s.t}</div><div style={{fontSize:13,color:'rgba(255,255,255,0.6)',lineHeight:1.5}}>{s.d}</div></div>
            </div>
          ))}
        </div>
      </div>
      {/* Pricing */}
      <div style={{background:'rgba(255,255,255,0.04)',padding:'48px 24px'}}>
        <div style={{maxWidth:680,margin:'0 auto'}}>
          <div style={{textAlign:'center',fontSize:12,fontWeight:800,color:'#D4A017',letterSpacing:2,textTransform:'uppercase',marginBottom:8}}>Pricing</div>
          <div style={{textAlign:'center',fontSize:22,fontWeight:900,color:'#fff',marginBottom:28}}>Simple, fair pricing</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14}}>
            {[{name:'Free',price:'£0',period:' forever',features:['All topics & questions','AI marking (5/day)','Spaced repetition','Streak tracking'],cta:'Start Free',hi:false},{name:'Student Plus',price:'£7.99',period:'/mo',features:['Unlimited AI marking','Socratic tutoring','Progress reports','XP & level system'],cta:'Start 7-day trial',hi:true},{name:'Tutor Connect',price:'£12.99',period:'/mo',features:['Everything in Plus','Parent dashboard','Tutor assignment','Weekly reports'],cta:'Get started',hi:false}].map(p=>(
              <div key={p.name} style={{background:p.hi?'linear-gradient(135deg,#D4A017,#E8B84B)':'rgba(255,255,255,0.06)',borderRadius:16,padding:'22px 16px',border:p.hi?'none':'1px solid rgba(255,255,255,0.1)',position:'relative'}}>
                {p.hi&&<div style={{position:'absolute',top:-10,left:'50%',transform:'translateX(-50%)',background:'#1B2A4A',color:'#D4A017',fontSize:8,fontWeight:800,padding:'3px 10px',borderRadius:6,letterSpacing:1,whiteSpace:'nowrap'}}>MOST POPULAR</div>}
                <div style={{fontSize:14,fontWeight:800,color:p.hi?'#1B2A4A':'#fff',marginBottom:4}}>{p.name}</div>
                <div style={{fontSize:28,fontWeight:900,color:p.hi?'#1B2A4A':'#D4A017',marginBottom:2}}>{p.price}<span style={{fontSize:11,fontWeight:500}}>{p.period}</span></div>
                <div style={{margin:'14px 0',borderTop:`1px solid ${p.hi?'rgba(0,0,0,0.1)':'rgba(255,255,255,0.1)'}`,paddingTop:14}}>
                  {p.features.map(f=><div key={f} style={{fontSize:10,color:p.hi?'#1B2A4A':'rgba(255,255,255,0.7)',marginBottom:5,display:'flex',gap:5}}><span style={{fontWeight:800}}>✓</span>{f}</div>)}
                </div>
                <button onClick={onStart} style={{width:'100%',padding:'9px 0',borderRadius:10,border:'none',background:p.hi?'#1B2A4A':'rgba(255,255,255,0.1)',color:p.hi?'#fff':'rgba(255,255,255,0.9)',fontWeight:800,fontSize:11,cursor:'pointer'}}>{p.cta}</button>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Footer */}
      <div style={{textAlign:'center',padding:'28px 24px',borderTop:'1px solid rgba(255,255,255,0.08)'}}>
        <div style={{fontSize:16,fontWeight:900,color:'#D4A017',marginBottom:4}}>📐 Lumora</div>
        <div style={{fontSize:11,color:'rgba(255,255,255,0.3)'}}>Built to close the attainment gap · GCSE Maths · AQA · Edexcel · OCR</div>
      </div>
    </div>
  );
}

// ═══ APP SHELL ═══════════════════════════════════════════════════════════════
export default function App(){
  const [screen,setScreen]=useState(()=>lsGet('lumora_profile',null)?'landing':'onboarding');
  const [page,setPage]=useState("platform");
  const [xpV,setXpV]=useState(0);
  const [celebration,setCelebration]=useState(null);

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

  const handleOnboardingComplete=()=>{touchStreak();setScreen('landing');};

  if(screen==='onboarding')return<><AnimStyles/><Onboarding onComplete={handleOnboardingComplete}/></>;
  if(screen==='landing')return<><AnimStyles/><LandingPage onStart={()=>setScreen('app')}/></>;

  const xp=getXP();
  return(
    <div style={{fontFamily:"'Segoe UI',sans-serif",background:"#f8f9fc",minHeight:"100vh"}}>
      <AnimStyles/>
      {celebration&&<Celebration data={celebration} onDone={()=>setCelebration(null)}/>}
      <div style={{background:"#1B2A4A",padding:"0 16px",display:"flex",alignItems:"center",position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 12px rgba(0,0,0,0.2)",gap:4}}>
        <button onClick={()=>setScreen('landing')} style={{fontSize:13,fontWeight:900,color:"#D4A017",letterSpacing:1,marginRight:16,padding:"14px 0",whiteSpace:"nowrap",background:'none',border:'none',cursor:'pointer'}}>📐 Lumora</button>
        {[{id:"platform",label:"📚 Revision"},{id:"generator",label:"⚡ Generator"},{id:"mock",label:"📝 Mock"}].map(tab=>(
          <button key={tab.id} onClick={()=>setPage(tab.id)} style={{padding:"14px 14px",border:"none",background:"none",cursor:"pointer",borderBottom:page===tab.id?"3px solid #D4A017":"3px solid transparent",color:page===tab.id?"#fff":"rgba(255,255,255,0.5)",fontWeight:page===tab.id?800:500,fontSize:12,transition:"all 0.2s",whiteSpace:"nowrap"}}>
            {tab.label}
          </button>
        ))}
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:10,padding:'0 4px'}}>
          <div style={{fontSize:11,color:'#D4A017',fontWeight:800}}>{getLevel(xp).icon} {xp} XP</div>
          <div style={{fontSize:11,color:'rgba(255,255,255,0.65)',fontWeight:700}}>🔥 {getStreakData().current}</div>
        </div>
      </div>
      {page==="platform"&&<Platform onXP={awardXP} xpV={xpV}/>}
      {page==="generator"&&<Generator/>}
      {page==="mock"&&<MockExam onXP={awardXP}/>}
    </div>
  );
}

// ═══ QCARD (Platform static questions — with SM-2 + AI marking) ═══════════
function QCard({q,idx,topicId,onAnswered,onXP}){
  const [open,setOpen]=useState(false);
  const [answered,setAnswered]=useState(null);
  const [working,setWorking]=useState('');
  const [aiResult,setAiResult]=useState(null);
  const [aiLoading,setAiLoading]=useState(false);
  const qid=`${topicId}:${idx}`;
  const d=DIFF[q.diff]||DIFF.Mid;

  const handleAnswer=(correct)=>{
    setAnswered(correct?'right':'wrong');
    sm2Update(qid,correct?4:1);
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

  const border=answered==='right'?'#27AE60':answered==='wrong'?'#E74C3C':'#e8e8e8';
  const bg=answered==='right'?'#f0fff4':answered==='wrong'?'#fff5f5':'#fff';

  return(
    <div style={{border:`1.5px solid ${border}`,borderRadius:12,marginBottom:12,overflow:'hidden',background:bg,transition:'all 0.2s'}}>
      <div style={{padding:'14px 18px'}}>
        <div style={{display:'flex',gap:8,marginBottom:8,flexWrap:'wrap',alignItems:'center'}}>
          <span style={{width:24,height:24,borderRadius:'50%',background:'#1B2A4A',color:'#D4A017',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:11,flexShrink:0}}>{idx+1}</span>
          <span style={{background:d.bg,color:d.c,fontSize:11,fontWeight:800,padding:'2px 8px',borderRadius:6}}>{q.diff}</span>
          <span style={{fontSize:11,color:'#999',fontWeight:600}}>[{q.marks} mark{q.marks>1?'s':''}]</span>
          {answered&&<span style={{fontSize:11,fontWeight:800,color:answered==='right'?'#27AE60':'#E74C3C'}}>{answered==='right'?'✓ Got it':'✗ Wrong'}</span>}
        </div>
        <p style={{margin:'0 0 12px',fontSize:14,lineHeight:1.65,color:'#1a1a2e',whiteSpace:'pre-line'}}>{q.q}</p>
        <div>
          <div style={{fontSize:11,fontWeight:700,color:'#888',marginBottom:4}}>📝 Your working:</div>
          <textarea value={working} onChange={e=>setWorking(e.target.value)} placeholder="Write your working here..." style={{width:'100%',minHeight:68,padding:10,borderRadius:8,border:'1.5px solid #e0e0e0',fontSize:13,fontFamily:'inherit',resize:'vertical',boxSizing:'border-box',outline:'none'}}/>
        </div>
      </div>

      {open&&(
        <div style={{borderTop:'1.5px solid #e8f5e9',background:'#f8fffe',padding:'14px 18px'}}>
          <div style={{fontSize:11,fontWeight:800,color:'#27AE60',textTransform:'uppercase',letterSpacing:1,marginBottom:8}}>✓ Mark Scheme</div>
          {q.ms.map((m,i)=><div key={i} style={{fontSize:13,color:'#2d3436',padding:'3px 0',display:'flex',gap:8}}><span style={{color:'#27AE60',fontWeight:700}}>›</span>{m}</div>)}
          {q.insight&&<div style={{background:'#E8F4F8',borderLeft:'3px solid #0D6E72',borderRadius:'0 8px 8px 0',padding:'10px 14px',marginTop:10}}>
            <div style={{fontSize:11,fontWeight:800,color:'#0D6E72'}}>💡 Examiner Insight</div>
            <p style={{margin:'4px 0 0',fontSize:13,color:'#2d3436',lineHeight:1.5}}>{q.insight}</p>
          </div>}

          {!answered&&(
            <div style={{marginTop:14}}>
              <div style={{fontSize:11,fontWeight:700,color:'#555',marginBottom:8}}>After checking the mark scheme, how did you do?</div>
              <div style={{display:'flex',gap:8}}>
                <button onClick={()=>handleAnswer(true)} style={{flex:1,padding:9,borderRadius:8,border:'none',background:'#27AE60',color:'#fff',fontWeight:800,fontSize:12,cursor:'pointer'}}>✓ Got It</button>
                <button onClick={()=>handleAnswer(false)} style={{flex:1,padding:9,borderRadius:8,border:'none',background:'#E74C3C',color:'#fff',fontWeight:800,fontSize:12,cursor:'pointer'}}>✗ Wrong</button>
              </div>
            </div>
          )}

          {working.trim()&&(
            <div style={{marginTop:12}}>
              <button onClick={handleAI} disabled={aiLoading} style={{width:'100%',padding:9,borderRadius:8,border:'none',background:aiLoading?'#ccc':'linear-gradient(135deg,#1B2A4A,#0D6E72)',color:'#fff',fontWeight:800,fontSize:12,cursor:aiLoading?'not-allowed':'pointer'}}>
                {aiLoading?'🤖 Marking your working...':'🤖 Get AI Feedback on My Working'}
              </button>
              {aiResult&&!aiResult.error&&(
                <div style={{marginTop:10,background:'#f0f8ff',border:'1.5px solid #3498DB',borderRadius:10,padding:14}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                    <div style={{fontSize:13,fontWeight:800,color:'#1B2A4A'}}>🤖 AI Feedback</div>
                    <div style={{fontSize:22,fontWeight:900,color:aiResult.marksEarned===aiResult.maxMarks?'#27AE60':aiResult.marksEarned>0?'#E8B84B':'#E74C3C'}}>
                      {aiResult.marksEarned}/{q.marks}
                    </div>
                  </div>
                  {aiResult.feedback&&<p style={{margin:'0 0 6px',fontSize:13,color:'#2d3436',lineHeight:1.5}}>✓ {aiResult.feedback}</p>}
                  {aiResult.improvements&&<p style={{margin:'0 0 8px',fontSize:13,color:'#2d3436',lineHeight:1.5}}>→ {aiResult.improvements}</p>}
                  {aiResult.breakdown?.map((m,i)=><div key={i} style={{fontSize:12,color:'#555',padding:'2px 0',fontFamily:'monospace'}}>{m}</div>)}
                  <SocraticChat question={q.q} ms={q.ms} aiResult={aiResult}/>
                </div>
              )}
              {aiResult?.error&&<div style={{marginTop:8,background:'#fff5f5',borderRadius:8,padding:'8px 12px',color:'#E74C3C',fontSize:12}}>{aiResult.error}</div>}
            </div>
          )}
        </div>
      )}

      <div style={{padding:'8px 18px',display:'flex',gap:8,background:'#fafafa',borderTop:'1px solid #f0f0f0'}}>
        <button onClick={()=>setOpen(!open)} style={{flex:1,padding:'7px 0',borderRadius:7,border:'1.5px solid #1B2A4A',background:open?'#1B2A4A':'transparent',color:open?'#fff':'#1B2A4A',fontSize:11,fontWeight:700,cursor:'pointer'}}>
          {open?'Hide Answer':'Show Mark Scheme'}
        </button>
      </div>
    </div>
  );
}

// ═══ TOPIC PAGE ═══════════════════════════════════════════════════════════════
function TopicPage({topic,moduleColor,onAnswered,onXP}){
  const [tab,setTab]=useState("questions");
  const tabs=[{id:"questions",l:"Questions"},{id:"boards",l:"Board Diff"},{id:"concept",l:"Core Concept"},{id:"markscheme",l:"Mark Scheme"},{id:"mistakes",l:"Mistakes"}];
  return(
    <div>
      <div style={{display:'flex',gap:4,marginBottom:18,overflowX:'auto'}}>
        {tabs.map(t=><button key={t.id} onClick={()=>setTab(t.id)} style={{padding:'7px 12px',borderRadius:8,border:'none',background:tab===t.id?moduleColor:'#f0f0f0',color:tab===t.id?'#fff':'#555',fontWeight:700,fontSize:12,cursor:'pointer',flexShrink:0}}>{t.l}</button>)}
      </div>
      {tab==="questions"&&topic.questions.map((q,i)=><QCard key={i} q={q} idx={i} topicId={topic.id} onAnswered={onAnswered} onXP={onXP}/>)}
      {tab==="boards"&&Object.entries(topic.boards).map(([b,txt])=>{
        const bc={AQA:{bg:"#EBF5FB",bd:"#1B2A4A",c:"#1B2A4A"},Edexcel:{bg:"#FDEDEC",bd:"#C0392B",c:"#C0392B"},OCR:{bg:"#E8F8F5",bd:"#0D6E72",c:"#0D6E72"}}[b];
        return<div key={b} style={{background:bc.bg,border:`1.5px solid ${bc.bd}`,borderRadius:10,padding:'14px 18px',marginBottom:10}}>
          <span style={{background:bc.c,color:'#fff',fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:4,letterSpacing:1,display:'inline-block',marginBottom:8}}>{b}</span>
          <p style={{margin:0,fontSize:13,lineHeight:1.6,color:'#2d3436'}}>{txt}</p>
        </div>;
      })}
      {tab==="concept"&&<div style={{background:'linear-gradient(135deg,#1B2A4A,#0D6E72)',borderRadius:14,padding:24,color:'#fff'}}>
        <div style={{fontSize:36,marginBottom:8}}>{topic.analogy.icon}</div>
        <div style={{fontSize:17,fontWeight:800,color:'#D4A017',marginBottom:14}}>{topic.analogy.title}</div>
        {topic.analogy.lines.map((l,i)=><div key={i} style={{fontSize:13,lineHeight:1.8,color:l.startsWith(" ")?"#93cfdf":"#fff",fontFamily:l.startsWith(" ")?"monospace":"inherit"}}>{l||" "}</div>)}
      </div>}
      {tab==="markscheme"&&<div style={{background:'#f0fff4',border:'1.5px solid #27AE60',borderRadius:12,padding:20}}>
        <div style={{fontSize:12,fontWeight:800,color:'#27AE60',textTransform:'uppercase',letterSpacing:1,marginBottom:12}}>✓ What Earns Marks</div>
        {topic.markScheme.map((m,i)=><div key={i} style={{display:'flex',gap:10,marginBottom:10}}><div style={{width:6,height:6,borderRadius:'50%',background:'#27AE60',marginTop:7,flexShrink:0}}/><p style={{margin:0,fontSize:13,lineHeight:1.6,color:'#2d3436'}}>{m}</p></div>)}
      </div>}
      {tab==="mistakes"&&<div style={{background:'#fff5f5',border:'1.5px solid #E74C3C',borderRadius:12,padding:20}}>
        <div style={{fontSize:12,fontWeight:800,color:'#E74C3C',textTransform:'uppercase',letterSpacing:1,marginBottom:12}}>✗ Common Mistakes</div>
        {topic.mistakes.map((m,i)=><div key={i} style={{display:'flex',gap:10,marginBottom:12}}><div style={{minWidth:20,height:20,borderRadius:'50%',background:'#E74C3C',color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:800,flexShrink:0}}>{i+1}</div><p style={{margin:0,fontSize:13,lineHeight:1.6,color:'#2d3436'}}>{m}</p></div>)}
      </div>}
    </div>
  );
}

// ═══ DUE FOR REVIEW ══════════════════════════════════════════════════════════
function DueForReview({onNavigate,version}){
  const dueIds=getDueIds();
  const dueQs=dueIds.map(id=>QUESTION_MAP[id]).filter(Boolean);
  if(!dueQs.length)return(
    <div style={{background:'#f0fff4',border:'1.5px solid #27AE60',borderRadius:12,padding:'12px 18px',marginBottom:16}}>
      <div style={{fontSize:12,fontWeight:800,color:'#27AE60'}}>✓ No reviews due today — you're all caught up!</div>
    </div>
  );
  return(
    <div style={{background:'#fff3cd',border:'1.5px solid #E8B84B',borderRadius:12,padding:'14px 18px',marginBottom:16}}>
      <div style={{fontSize:12,fontWeight:800,color:'#856404',marginBottom:10}}>🔔 Due for Review — {dueQs.length} question{dueQs.length!==1?'s':''}</div>
      <div style={{display:'grid',gap:8}}>
        {dueQs.slice(0,5).map(q=>(
          <div key={q.qid} style={{background:'#fff',borderRadius:8,padding:'10px 12px',display:'flex',alignItems:'center',justifyContent:'space-between',gap:10}}>
            <div style={{overflow:'hidden'}}>
              <div style={{fontSize:12,fontWeight:700,color:'#1a1a2e',marginBottom:2}}>{q.topicTitle}</div>
              <div style={{fontSize:11,color:'#888',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:220}}>{q.q?.slice(0,55)}...</div>
            </div>
            <button onClick={()=>onNavigate(q.topicId)} style={{padding:'6px 12px',borderRadius:8,border:'none',background:'#E8B84B',color:'#1B2A4A',fontWeight:800,fontSize:11,cursor:'pointer',flexShrink:0}}>Review →</button>
          </div>
        ))}
        {dueQs.length>5&&<div style={{fontSize:11,color:'#856404',textAlign:'center'}}>+{dueQs.length-5} more due today</div>}
      </div>
    </div>
  );
}

// ═══ WEAKNESS HEATMAP ════════════════════════════════════════════════════════
function WeaknessHeatmap({onNavigate,version}){
  const perf=lsGet('gcse_perf',{});
  const allTopics=MODULES.flatMap(m=>m.topics.map(t=>({...t,moduleLabel:m.label,moduleColor:m.color})));
  return(
    <div style={{background:'#fff',borderRadius:12,border:'1.5px solid #e8e8e8',padding:'16px 18px',marginBottom:16}}>
      <div style={{fontSize:12,fontWeight:800,color:'#888',textTransform:'uppercase',letterSpacing:1,marginBottom:12}}>🌡️ Performance Heatmap</div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(135px,1fr))',gap:7}}>
        {allTopics.map(t=>{
          const p=perf[t.id];
          const ratio=p&&p.total>0?p.correct/p.total:null;
          const hc=heatColor(ratio);
          return(
            <button key={t.id} onClick={()=>onNavigate(t.id)} style={{background:hc.bg,border:`1.5px solid ${hc.c}33`,borderRadius:8,padding:'8px 10px',textAlign:'left',cursor:'pointer',transition:'all 0.2s'}}>
              <div style={{fontSize:9,fontWeight:800,color:hc.c,textTransform:'uppercase',marginBottom:2}}>{t.moduleLabel}</div>
              <div style={{fontSize:11,fontWeight:700,color:hc.c,lineHeight:1.3,marginBottom:3}}>{t.title}</div>
              <div style={{fontSize:10,color:hc.c}}>{ratio!==null?`${Math.round(ratio*100)}% (${p.correct}/${p.total})`:'Not attempted'}</div>
            </button>
          );
        })}
      </div>
      <div style={{display:'flex',gap:14,marginTop:10,flexWrap:'wrap'}}>
        {[{bg:'#d4edda',c:'#155724',l:'Strong ≥70%'},{bg:'#fff3cd',c:'#856404',l:'Improving 40–69%'},{bg:'#f8d7da',c:'#721c24',l:'Needs work <40%'},{bg:'#f0f0f0',c:'#999',l:'Not attempted'}].map(x=>(
          <div key={x.l} style={{display:'flex',gap:5,alignItems:'center'}}>
            <div style={{width:10,height:10,borderRadius:2,background:x.bg,border:`1px solid ${x.c}55`}}/>
            <span style={{fontSize:10,color:'#666'}}>{x.l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══ PLATFORM ════════════════════════════════════════════════════════════════
export function Platform({onXP=()=>{},xpV=0}){
  const [modId,setModId]=useState(null);
  const [topicId,setTopicId]=useState(null);
  const [search,setSearch]=useState("");
  const [board,setBoard]=useState("All");
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
    <div style={{fontFamily:"'Segoe UI',sans-serif",maxWidth:680,margin:"0 auto",padding:16,background:"#f8f9fc",minHeight:"100vh"}}>
      <div style={{background:"#fff",borderRadius:14,padding:"14px 18px",marginBottom:14,boxShadow:"0 2px 10px rgba(0,0,0,0.06)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
          <button onClick={()=>{setModId(null);setTopicId(null);}} style={{background:"none",border:"none",cursor:"pointer",fontSize:16}}>⌂</button>
          <span style={{color:"#ccc"}}>›</span>
          <button onClick={()=>setTopicId(null)} style={{background:"none",border:"none",cursor:"pointer",fontSize:12,color:mod.color,fontWeight:700}}>{mod.label}</button>
          <span style={{color:"#ccc"}}>›</span>
          <span style={{fontSize:12,color:"#555",fontWeight:600}}>{topic.title}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:44,height:44,borderRadius:10,background:mod.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,color:"#fff",flexShrink:0}}>{mod.icon}</div>
          <div><div style={{fontSize:17,fontWeight:800,color:"#1a1a2e"}}>{topic.title}</div><div style={{fontSize:11,color:"#888",marginTop:2}}>{topic.questions.length} questions · 3 difficulty levels</div></div>
        </div>
      </div>
      <TopicPage topic={topic} moduleColor={mod.color} onAnswered={handleAnswered} onXP={onXP}/>
    </div>
  );

  if(mod)return(
    <div style={{fontFamily:"'Segoe UI',sans-serif",maxWidth:680,margin:"0 auto",padding:16,background:"#f8f9fc",minHeight:"100vh"}}>
      <div style={{background:mod.color,borderRadius:16,padding:"22px",marginBottom:14,position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",right:-20,top:-20,fontSize:110,opacity:0.1,fontWeight:900}}>{mod.icon}</div>
        <button onClick={()=>setModId(null)} style={{background:"rgba(255,255,255,0.2)",border:"none",borderRadius:8,padding:"5px 12px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",marginBottom:10}}>← Back</button>
        <div style={{fontSize:22,fontWeight:900,color:"#fff"}}>{mod.label}</div>
        <div style={{fontSize:12,color:"rgba(255,255,255,0.8)",marginTop:4}}>{mod.topics.length} topics</div>
      </div>
      <div style={{display:"grid",gap:10}}>
        {mod.topics.map(t=>(
          <button key={t.id} onClick={()=>setTopicId(t.id)} style={{background:"#fff",border:"1.5px solid #e8e8e8",borderRadius:12,padding:"16px 18px",textAlign:"left",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:"#1a1a2e",marginBottom:4}}>{t.title}</div>
              <div style={{display:"flex",gap:5,alignItems:"center"}}>
                {t.questions.map((q,i)=><span key={i} style={{width:8,height:8,borderRadius:"50%",background:DIFF[q.diff].c,display:"inline-block"}}/>)}
                <span style={{fontSize:10,color:"#aaa",marginLeft:4}}>{t.questions.length} questions</span>
              </div>
            </div>
            <span style={{fontSize:20,color:mod.color}}>›</span>
          </button>
        ))}
      </div>
    </div>
  );

  return(
    <div style={{fontFamily:"'Segoe UI',sans-serif",maxWidth:680,margin:"0 auto",padding:16,background:"#f8f9fc",minHeight:"100vh"}}>
      <div style={{background:"linear-gradient(135deg,#1B2A4A,#0D4A4A)",borderRadius:18,padding:"26px 22px",marginBottom:18,position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",right:-20,top:-20,width:140,height:140,borderRadius:"50%",background:"rgba(212,160,23,0.15)"}}/>
        <div style={{position:"relative"}}>
          <div style={{fontSize:10,fontWeight:800,color:"#D4A017",letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>GCSE Maths · AQA · Edexcel · OCR</div>
          <div style={{fontSize:24,fontWeight:900,color:"#fff",lineHeight:1.2,marginBottom:4}}>Master Framework</div>
          <div style={{fontSize:12,color:"rgba(255,255,255,0.7)",marginBottom:14}}>Every topic · Every board · Taught from the mark scheme</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {["AQA","Edexcel","OCR"].map(b=><button key={b} onClick={()=>setBoard(board===b?"All":b)} style={{padding:"5px 12px",borderRadius:20,border:`1.5px solid ${board===b?"#D4A017":"rgba(255,255,255,0.3)"}`,background:board===b?"#D4A017":"transparent",color:board===b?"#1B2A4A":"#fff",fontSize:11,fontWeight:800,cursor:"pointer",letterSpacing:1}}>{b}</button>)}
          </div>
        </div>
      </div>

      <div style={{position:"relative",marginBottom:16}}>
        <span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",fontSize:15,color:"#aaa"}}>⌕</span>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search topics..." style={{width:"100%",padding:"11px 16px 11px 40px",borderRadius:10,border:"1.5px solid #e0e0e0",fontSize:14,background:"#fff",outline:"none",boxSizing:"border-box"}}/>
      </div>
      {search.trim().length>1&&(
        <div style={{marginBottom:16}}>
          <div style={{fontSize:11,fontWeight:700,color:"#888",textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>{searchRes.length} result{searchRes.length!==1?"s":""}</div>
          {searchRes.map(t=><button key={t.id} onClick={()=>{setModId(t.mod.id);setTopicId(t.id);setSearch("");}} style={{width:"100%",background:"#fff",border:"1.5px solid #e0e0e0",borderRadius:10,padding:"12px 16px",textAlign:"left",cursor:"pointer",marginBottom:8,display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:32,height:32,borderRadius:8,background:t.mod.color,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:14,flexShrink:0}}>{t.mod.icon}</div>
            <div><div style={{fontSize:13,fontWeight:700,color:"#1a1a2e"}}>{t.title}</div><div style={{fontSize:11,color:"#888"}}>{t.mod.label}</div></div>
          </button>)}
        </div>
      )}

      <GamificationBar key={`gam-${xpV}`} xp={xp}/>
      <DueForReview key={`due-${version}`} onNavigate={navigateToTopic} version={version}/>
      <WeaknessHeatmap key={`heat-${version}`} onNavigate={navigateToTopic} version={version}/>

      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:16}}>
        {[{l:"Modules",v:MODULES.length,c:"#1B2A4A"},{l:"Topics",v:totalT,c:"#0D6E72"},{l:"Questions",v:totalQ,c:"#D4A017"}].map(s=>(
          <div key={s.l} style={{background:"#fff",borderRadius:10,padding:"12px",textAlign:"center",border:"1.5px solid #f0f0f0"}}>
            <div style={{fontSize:22,fontWeight:900,color:s.c}}>{s.v}</div>
            <div style={{fontSize:10,color:"#888",fontWeight:600,marginTop:2}}>{s.l}</div>
          </div>
        ))}
      </div>
      <div style={{fontSize:11,fontWeight:800,color:"#888",textTransform:"uppercase",letterSpacing:1,marginBottom:12}}>All Modules</div>
      <div style={{display:"grid",gap:12}}>
        {MODULES.map(m=>(
          <button key={m.id} onClick={()=>setModId(m.id)} style={{background:"#fff",border:"1.5px solid #e8e8e8",borderRadius:14,padding:"18px",textAlign:"left",cursor:"pointer",position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",right:-10,top:-10,fontSize:65,opacity:0.07,fontWeight:900}}>{m.icon}</div>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <div style={{width:46,height:46,borderRadius:12,background:m.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,color:"#fff",flexShrink:0}}>{m.icon}</div>
              <div style={{flex:1}}>
                <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:10,fontWeight:800,color:m.color,letterSpacing:1}}>{m.code}</span><span style={{fontSize:12,color:"#aaa"}}>{m.topics.length} topics →</span></div>
                <div style={{fontSize:15,fontWeight:800,color:"#1a1a2e",marginTop:2}}>{m.label}</div>
                <div style={{display:"flex",gap:4,marginTop:8,flexWrap:"wrap"}}>
                  {m.topics.map(t=><span key={t.id} style={{fontSize:9,color:"#777",background:"#f5f5f5",padding:"2px 6px",borderRadius:4}}>{t.title}</span>)}
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

  return(
    <div style={{background:'#fff',border:`1.5px solid ${selfMark!=null?selfMark>0?'#27AE60':'#E74C3C':'#e8e8e8'}`,borderRadius:12,marginBottom:12,overflow:'hidden'}}>
      <div style={{padding:'14px 18px'}}>
        <div style={{display:'flex',gap:8,marginBottom:8,alignItems:'center',flexWrap:'wrap'}}>
          <span style={{width:24,height:24,borderRadius:'50%',background:'#1B2A4A',color:'#D4A017',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:11,flexShrink:0}}>{idx+1}</span>
          <span style={{background:d.bg,color:d.c,fontSize:11,fontWeight:800,padding:'2px 8px',borderRadius:6}}>{q.diff}</span>
          <span style={{fontSize:11,color:'#999',fontWeight:600}}>[{q.marks} marks]</span>
          <span style={{fontSize:10,color:'#bbb'}}>{q.topicTitle}</span>
          {selfMark!=null&&<span style={{fontSize:12,fontWeight:800,color:selfMark>0?'#27AE60':'#E74C3C',marginLeft:'auto'}}>{selfMark}/{q.marks}</span>}
        </div>
        <p style={{margin:0,fontSize:14,lineHeight:1.65,color:'#1a1a2e',whiteSpace:'pre-line'}}>{q.q}</p>
        {working&&<div style={{marginTop:10,background:'#f8f9fa',borderRadius:8,padding:'10px 12px'}}>
          <div style={{fontSize:10,fontWeight:700,color:'#888',marginBottom:4,textTransform:'uppercase'}}>Your Working</div>
          <div style={{fontSize:13,color:'#2d3436',whiteSpace:'pre-wrap',fontFamily:'monospace'}}>{working}</div>
        </div>}
      </div>
      {showMS&&(
        <div style={{borderTop:'1.5px solid #e8f5e9',background:'#f8fffe',padding:'14px 18px'}}>
          <div style={{fontSize:11,fontWeight:800,color:'#27AE60',textTransform:'uppercase',letterSpacing:1,marginBottom:8}}>✓ Mark Scheme</div>
          {q.ms.map((m,i)=><div key={i} style={{fontSize:13,color:'#2d3436',padding:'3px 0',display:'flex',gap:8}}><span style={{color:'#27AE60',fontWeight:700}}>›</span>{m}</div>)}
          {q.insight&&<div style={{background:'#E8F4F8',borderLeft:'3px solid #0D6E72',borderRadius:'0 8px 8px 0',padding:'10px 14px',marginTop:10}}>
            <div style={{fontSize:11,fontWeight:800,color:'#0D6E72'}}>💡 Examiner Insight</div>
            <p style={{margin:'4px 0 0',fontSize:13,color:'#2d3436',lineHeight:1.5}}>{q.insight}</p>
          </div>}
          <div style={{marginTop:12,background:'#fff9e6',borderRadius:10,padding:12}}>
            <div style={{fontSize:11,fontWeight:700,color:'#856404',marginBottom:8}}>Self-mark: how many marks did you earn?</div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              {Array.from({length:q.marks+1},(_,i)=>i).map(m=>(
                <button key={m} onClick={()=>onSelfMark(m)} style={{padding:'8px 14px',borderRadius:8,border:`1.5px solid ${selfMark===m?'#1B2A4A':'#e0e0e0'}`,background:selfMark===m?'#1B2A4A':'#fff',color:selfMark===m?'#fff':'#555',fontWeight:800,fontSize:13,cursor:'pointer'}}>{m}/{q.marks}</button>
              ))}
            </div>
          </div>
          {working&&(
            <div style={{marginTop:10}}>
              <button onClick={handleAI} disabled={aiLoading} style={{width:'100%',padding:9,borderRadius:8,border:'none',background:aiLoading?'#ccc':'linear-gradient(135deg,#1B2A4A,#0D6E72)',color:'#fff',fontWeight:800,fontSize:12,cursor:aiLoading?'not-allowed':'pointer'}}>
                {aiLoading?'🤖 Marking...':'🤖 Get AI Feedback on My Working'}
              </button>
              {aiResult&&!aiResult.error&&(
                <div style={{marginTop:10,background:'#f0f8ff',border:'1.5px solid #3498DB',borderRadius:10,padding:14}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
                    <span style={{fontSize:13,fontWeight:800,color:'#1B2A4A'}}>🤖 AI Feedback</span>
                    <span style={{fontSize:20,fontWeight:900,color:aiResult.marksEarned===q.marks?'#27AE60':aiResult.marksEarned>0?'#E8B84B':'#E74C3C'}}>{aiResult.marksEarned}/{q.marks}</span>
                  </div>
                  {aiResult.feedback&&<p style={{margin:'0 0 6px',fontSize:13,lineHeight:1.5}}>✓ {aiResult.feedback}</p>}
                  {aiResult.improvements&&<p style={{margin:'0 0 8px',fontSize:13,lineHeight:1.5}}>→ {aiResult.improvements}</p>}
                  {aiResult.breakdown?.map((m,i)=><div key={i} style={{fontSize:12,color:'#555',padding:'2px 0',fontFamily:'monospace'}}>{m}</div>)}
                  <SocraticChat question={q.q} ms={q.ms} aiResult={aiResult}/>
                </div>
              )}
              {aiResult?.error&&<div style={{marginTop:8,background:'#fff5f5',borderRadius:8,padding:'8px 12px',color:'#E74C3C',fontSize:12}}>{aiResult.error}</div>}
            </div>
          )}
        </div>
      )}
      <div style={{padding:'8px 18px',background:'#fafafa',borderTop:'1px solid #f0f0f0'}}>
        <button onClick={()=>setShowMS(!showMS)} style={{width:'100%',padding:'7px 0',borderRadius:7,border:'1.5px solid #27AE60',background:showMS?'#27AE60':'transparent',color:showMS?'#fff':'#27AE60',fontSize:11,fontWeight:700,cursor:'pointer'}}>
          {showMS?'Hide Mark Scheme':'✓ Show Mark Scheme & Self-Mark'}
        </button>
      </div>
    </div>
  );
}

export function MockExam({onXP=()=>{}}){
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
  },[started,submitted,timeLeft]);

  const fmt=s=>`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  const totalMarks=questions.reduce((s,q)=>s+q.marks,0);
  const earnedMarks=Object.values(selfMarks).reduce((s,m)=>s+m,0);
  const markedCount=Object.keys(selfMarks).length;
  const pct=totalMarks>0?Math.round(earnedMarks/totalMarks*100):0;

  if(!started)return(
    <div style={{maxWidth:640,margin:'0 auto',padding:24,fontFamily:"'Segoe UI',sans-serif"}}>
      <div style={{background:'linear-gradient(135deg,#1B2A4A,#0D4A4A)',borderRadius:18,padding:28,color:'#fff',textAlign:'center',marginBottom:20}}>
        <div style={{fontSize:48,marginBottom:12}}>📝</div>
        <div style={{fontSize:24,fontWeight:900,marginBottom:8}}>Timed Mock Exam</div>
        <div style={{fontSize:13,color:'rgba(255,255,255,0.7)',marginBottom:20}}>20 mixed questions from all topics</div>
        <div style={{display:'flex',gap:12,justifyContent:'center',flexWrap:'wrap'}}>
          {[{l:'Questions',v:'20'},{l:'Time',v:'45 min'},{l:'Topics',v:'Mixed'},{l:'Total Marks',v:String(totalMarks)}].map(s=>(
            <div key={s.l} style={{background:'rgba(255,255,255,0.1)',borderRadius:10,padding:'10px 16px',minWidth:80}}>
              <div style={{fontSize:20,fontWeight:900,color:'#D4A017'}}>{s.v}</div>
              <div style={{fontSize:10,color:'rgba(255,255,255,0.6)'}}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{background:'#fff',borderRadius:14,padding:20,marginBottom:16,border:'1.5px solid #e8e8e8'}}>
        <div style={{fontSize:13,fontWeight:800,color:'#1B2A4A',marginBottom:10}}>📋 Instructions</div>
        {['45 minutes for 20 questions from all topics.','Write your working in the boxes provided.','Submit when done — or the timer will auto-submit.','After submission, reveal each mark scheme and self-mark.','AI marking is available if you have an API key set up.'].map((t,i)=>(
          <div key={i} style={{display:'flex',gap:8,marginBottom:6,fontSize:13,color:'#444'}}>
            <span style={{color:'#D4A017',fontWeight:700,flexShrink:0}}>{i+1}.</span>{t}
          </div>
        ))}
      </div>
      <button onClick={()=>setStarted(true)} style={{width:'100%',padding:16,borderRadius:12,border:'none',background:'linear-gradient(135deg,#1B2A4A,#0D6E72)',color:'#fff',fontSize:15,fontWeight:900,cursor:'pointer',boxShadow:'0 4px 18px rgba(27,42,74,0.3)'}}>
        🏁 Start Exam
      </button>
    </div>
  );

  if(submitted)return(
    <div style={{maxWidth:680,margin:'0 auto',padding:20,fontFamily:"'Segoe UI',sans-serif"}}>
      <div style={{background:'linear-gradient(135deg,#1B2A4A,#0D4A4A)',borderRadius:18,padding:24,color:'#fff',textAlign:'center',marginBottom:20}}>
        <div style={{fontSize:40,marginBottom:8}}>{pct>=70?'🏆':pct>=50?'📊':'📚'}</div>
        <div style={{fontSize:20,fontWeight:900,marginBottom:4}}>Exam Complete!</div>
        {markedCount>0?(
          <>
            <div style={{fontSize:44,fontWeight:900,color:'#D4A017'}}>{earnedMarks}/{totalMarks}</div>
            <div style={{fontSize:14,color:'rgba(255,255,255,0.8)'}}>{pct}% — {markedCount}/{questions.length} questions self-marked</div>
          </>
        ):(
          <div style={{fontSize:14,color:'rgba(255,255,255,0.7)'}}>Reveal each mark scheme below and self-mark to see your score</div>
        )}
      </div>
      {questions.map((q,i)=>(
        <MockQCard key={q.qid} q={q} idx={i} working={workings[i]||''} selfMark={selfMarks[i]} onSelfMark={m=>setSelfMarks(s=>({...s,[i]:m}))}/>
      ))}
    </div>
  );

  return(
    <div style={{maxWidth:680,margin:'0 auto',padding:20,fontFamily:"'Segoe UI',sans-serif"}}>
      <div style={{position:'sticky',top:52,zIndex:99,background:'#fff',borderRadius:12,padding:'10px 16px',marginBottom:14,boxShadow:'0 2px 10px rgba(0,0,0,0.1)',display:'flex',justifyContent:'space-between',alignItems:'center',border:`1.5px solid ${timeLeft<300?'#E74C3C':'#e0e0e0'}`,overflow:'hidden'}}>
        <div>
          <div style={{fontSize:10,fontWeight:700,color:'#888',textTransform:'uppercase'}}>Time Remaining</div>
          <div style={{fontSize:24,fontWeight:900,color:timeLeft<300?'#E74C3C':'#1B2A4A',fontFamily:'monospace'}}>{fmt(timeLeft)}</div>
        </div>
        <div style={{textAlign:'center'}}>
          <div style={{fontSize:10,fontWeight:700,color:'#888',textTransform:'uppercase'}}>Progress</div>
          <div style={{fontSize:14,fontWeight:800,color:'#1B2A4A'}}>20 Qs · {totalMarks} marks</div>
        </div>
        <button onClick={handleSubmit} style={{padding:'10px 18px',borderRadius:10,border:'none',background:'#1B2A4A',color:'#fff',fontWeight:800,fontSize:12,cursor:'pointer'}}>Submit →</button>
        <div style={{position:'absolute',bottom:0,left:0,height:3,background:timeLeft<300?'#E74C3C':'#1B2A4A',width:`${(timeLeft/TOTAL_TIME)*100}%`,transition:'width 1s linear'}}/>
      </div>

      {questions.map((q,i)=>(
        <div key={q.qid} style={{background:'#fff',border:'1.5px solid #e8e8e8',borderRadius:12,marginBottom:10,overflow:'hidden'}}>
          <div style={{padding:'14px 18px'}}>
            <div style={{display:'flex',gap:8,marginBottom:8,alignItems:'center',flexWrap:'wrap'}}>
              <span style={{width:24,height:24,borderRadius:'50%',background:'#1B2A4A',color:'#D4A017',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:11,flexShrink:0}}>{i+1}</span>
              <span style={{background:(DIFF[q.diff]||DIFF.Mid).bg,color:(DIFF[q.diff]||DIFF.Mid).c,fontSize:11,fontWeight:800,padding:'2px 8px',borderRadius:6}}>{q.diff}</span>
              <span style={{fontSize:11,color:'#999',fontWeight:600}}>[{q.marks} mark{q.marks>1?'s':''}]</span>
              <span style={{fontSize:10,color:'#bbb'}}>{q.topicTitle}</span>
            </div>
            <p style={{margin:'0 0 10px',fontSize:14,lineHeight:1.65,color:'#1a1a2e',whiteSpace:'pre-line'}}>{q.q}</p>
            <textarea value={workings[i]||''} onChange={e=>setWorkings(w=>({...w,[i]:e.target.value}))} placeholder="Write your working here..." style={{width:'100%',minHeight:68,padding:10,borderRadius:8,border:'1.5px solid #e0e0e0',fontSize:13,fontFamily:'inherit',resize:'vertical',boxSizing:'border-box',outline:'none'}}/>
          </div>
        </div>
      ))}
      <button onClick={handleSubmit} style={{width:'100%',padding:14,borderRadius:12,border:'none',background:'linear-gradient(135deg,#1B2A4A,#0D6E72)',color:'#fff',fontSize:14,fontWeight:900,cursor:'pointer',marginBottom:24}}>
        📤 Submit Exam
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
  const bc=BCOLORS[board]||'#1B2A4A';
  return(
    <div style={{background:"#fff",border:"1.5px solid #e8e8e8",borderRadius:14,marginBottom:16,overflow:"hidden",boxShadow:"0 2px 10px rgba(0,0,0,0.05)"}}>
      <div style={{padding:"16px 20px 12px",borderBottom:"1px solid #f5f5f5"}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
          <div style={{display:"flex",gap:7,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{width:26,height:26,borderRadius:"50%",background:"#1B2A4A",color:"#D4A017",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900,fontSize:11}}>{idx+1}</div>
            <span style={{background:bc,color:"#fff",fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:4,letterSpacing:1}}>{board}</span>
            <span style={{background:d.bg,color:d.c,fontSize:11,fontWeight:800,padding:"2px 8px",borderRadius:6}}>{q.difficulty}</span>
            <span style={{fontSize:11,color:"#999",fontWeight:600}}>[{q.marks} mark{q.marks>1?"s":""}]</span>
          </div>
        </div>
        <p style={{margin:0,fontSize:14,lineHeight:1.7,color:"#1a1a2e",whiteSpace:"pre-line"}}>{q.question}</p>
      </div>
      {(show==="working"||show==="both")&&(
        <div style={{padding:"14px 20px",background:"#F8F9FA",borderBottom:"1px solid #eee"}}>
          <div style={{fontSize:11,fontWeight:800,color:"#555",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>📝 Worked Solution</div>
          <div style={{fontSize:13,lineHeight:1.9,color:"#2d3436",whiteSpace:"pre-line",fontFamily:"'Courier New',monospace"}}>{q.working}</div>
        </div>
      )}
      {(show==="marks"||show==="both")&&(
        <div style={{padding:"14px 20px",background:"#f0fff4",borderBottom:"1px solid #d5f5e3"}}>
          <div style={{fontSize:11,fontWeight:800,color:"#27AE60",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>✓ Mark Scheme</div>
          {q.mark_scheme.map((m,i)=><div key={i} style={{fontSize:13,color:"#2d3436",padding:"3px 0",display:"flex",gap:8}}><span style={{color:"#27AE60",fontWeight:700}}>›</span>{m}</div>)}
          {q.examiner_insight&&<div style={{background:"#E8F4F8",borderLeft:"3px solid #0D6E72",borderRadius:"0 8px 8px 0",padding:"10px 14px",marginTop:10}}>
            <div style={{fontSize:11,fontWeight:800,color:"#0D6E72",marginBottom:4}}>💡 {board} Examiner Insight</div>
            <p style={{margin:0,fontSize:13,color:"#2d3436",lineHeight:1.5}}>{q.examiner_insight}</p>
          </div>}
          {q.common_mistake&&<div style={{background:"#FFF5F5",borderLeft:"3px solid #E74C3C",borderRadius:"0 8px 8px 0",padding:"10px 14px",marginTop:8}}>
            <div style={{fontSize:11,fontWeight:800,color:"#E74C3C",marginBottom:4}}>✗ Most Common Mistake</div>
            <p style={{margin:0,fontSize:13,color:"#2d3436",lineHeight:1.5}}>{q.common_mistake}</p>
          </div>}
        </div>
      )}
      <div style={{padding:"10px 20px",display:"flex",gap:7,background:"#fafafa",flexWrap:"wrap"}}>
        <button onClick={()=>setShow(s=>s==="working"?"none":s==="marks"?"both":s==="both"?"marks":"working")}
          style={{flex:1,minWidth:110,padding:"7px 0",borderRadius:7,border:"1.5px solid #1B2A4A",background:(show==="working"||show==="both")?"#1B2A4A":"transparent",color:(show==="working"||show==="both")?"#fff":"#1B2A4A",fontSize:11,fontWeight:700,cursor:"pointer"}}>
          {(show==="working"||show==="both")?"Hide Working":"Show Working"}
        </button>
        <button onClick={()=>setShow(s=>s==="marks"?"none":s==="working"?"both":s==="both"?"working":"marks")}
          style={{flex:1,minWidth:110,padding:"7px 0",borderRadius:7,border:"1.5px solid #27AE60",background:(show==="marks"||show==="both")?"#27AE60":"transparent",color:(show==="marks"||show==="both")?"#fff":"#27AE60",fontSize:11,fontWeight:700,cursor:"pointer"}}>
          {(show==="marks"||show==="both")?"Hide Mark Scheme":"Show Mark Scheme"}
        </button>
      </div>
    </div>
  );
}

export function Generator(){
  const [cfg,setCfg]=useState({board:"AQA",tier:"Higher",topic:"percentages",topicLabel:"Percentages",diff:"Mid",count:3});
  const [qs,setQs]=useState([]);
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState(null);
  const [total,setTotal]=useState(0);
  const [filterMod,setFilterMod]=useState("All");
  const modules=["All",...new Set(TOPICS.map(t=>t.module))];
  const visibleTopics=filterMod==="All"?TOPICS:TOPICS.filter(t=>t.module===filterMod);

  const run=async()=>{
    setLoading(true);setErr(null);setQs([]);
    try{const data=await callAPI(cfg);setQs(data.questions);setTotal(t=>t+1);}
    catch(e){setErr(e.message);}
    setLoading(false);
  };

  return(
    <div style={{fontFamily:"'Segoe UI',sans-serif",maxWidth:820,margin:"0 auto",background:"#f8f9fc",minHeight:"100vh"}}>
      <div style={{background:"linear-gradient(135deg,#1B2A4A,#0D4A4A)",padding:"20px 24px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:"#D4A017",letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>GCSE MATHS</div>
            <div style={{fontSize:22,fontWeight:900,color:"#fff"}}>AI Question Generator</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.6)",marginTop:3}}>Infinite questions · Board-specific mark schemes · Examiner insights</div>
          </div>
          {total>0&&<div style={{background:"rgba(212,160,23,0.2)",borderRadius:10,padding:"8px 16px",textAlign:"center"}}>
            <div style={{fontSize:22,fontWeight:900,color:"#D4A017"}}>{total}</div>
            <div style={{fontSize:9,color:"rgba(255,255,255,0.6)",fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>sets made</div>
          </div>}
        </div>
      </div>
      <div style={{padding:"20px 24px"}}>
        {!import.meta.env.VITE_ANTHROPIC_API_KEY&&<div style={{background:'#fff3cd',border:'1.5px solid #E8B84B',borderRadius:10,padding:'12px 16px',marginBottom:16,fontSize:13,color:'#856404'}}>
          ⚠️ <strong>API key not set.</strong> Create <code>.env.local</code> in the project root with: <code>VITE_ANTHROPIC_API_KEY=sk-ant-...</code> then restart the dev server.
        </div>}
        <div style={{display:"grid",gridTemplateColumns:"280px 1fr",gap:20,alignItems:"start"}}>
          <div style={{background:"#fff",borderRadius:14,border:"1.5px solid #e8e8e8",overflow:"hidden",position:"sticky",top:60}}>
            <div style={{padding:"14px 16px",borderBottom:"1px solid #f0f0f0"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#888",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Exam Board</div>
              <div style={{display:"flex",gap:5}}>
                {["AQA","Edexcel","OCR"].map(b=><button key={b} onClick={()=>setCfg(c=>({...c,board:b}))} style={{flex:1,padding:"8px 0",borderRadius:8,border:`1.5px solid ${cfg.board===b?BCOLORS[b]:"#e0e0e0"}`,background:cfg.board===b?BCOLORS[b]:"#fff",color:cfg.board===b?"#fff":"#555",fontWeight:800,fontSize:11,cursor:"pointer"}}>{b}</button>)}
              </div>
            </div>
            <div style={{padding:"12px 16px",borderBottom:"1px solid #f0f0f0"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#888",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Tier</div>
              <div style={{display:"flex",gap:5}}>
                {["Foundation","Higher"].map(t=><button key={t} onClick={()=>setCfg(c=>({...c,tier:t}))} style={{flex:1,padding:"7px 0",borderRadius:8,border:`1.5px solid ${cfg.tier===t?"#1B2A4A":"#e0e0e0"}`,background:cfg.tier===t?"#1B2A4A":"#fff",color:cfg.tier===t?"#fff":"#555",fontWeight:700,fontSize:11,cursor:"pointer"}}>{t}</button>)}
              </div>
            </div>
            <div style={{padding:"12px 16px",borderBottom:"1px solid #f0f0f0"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#888",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Difficulty</div>
              <div style={{display:"grid",gap:5}}>
                {[{id:"Starter",desc:"1–2 marks · direct"},{id:"Mid",desc:"3–4 marks · multi-step"},{id:"Killer",desc:"4–6 marks · proof/evaluate"}].map(d=>{
                  const dc=DIFF[d.id];
                  return<button key={d.id} onClick={()=>setCfg(c=>({...c,diff:d.id}))} style={{padding:"8px 10px",borderRadius:8,border:`1.5px solid ${cfg.diff===d.id?dc.c:"#e0e0e0"}`,background:cfg.diff===d.id?dc.bg:"#fff",textAlign:"left",cursor:"pointer"}}>
                    <div style={{fontSize:12,fontWeight:800,color:cfg.diff===d.id?dc.c:"#555"}}>{d.id}</div>
                    <div style={{fontSize:10,color:"#aaa"}}>{d.desc}</div>
                  </button>;
                })}
              </div>
            </div>
            <div style={{padding:"12px 16px",borderBottom:"1px solid #f0f0f0"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#888",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>
                Questions: <span style={{color:"#1B2A4A",fontSize:14,fontWeight:900}}>{cfg.count}</span>
              </div>
              <input type="range" min={1} max={5} value={cfg.count} onChange={e=>setCfg(c=>({...c,count:+e.target.value}))} style={{width:"100%",accentColor:"#1B2A4A"}}/>
            </div>
            <div style={{padding:"12px 16px"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#888",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Topic</div>
              <div style={{display:"flex",gap:4,marginBottom:8,flexWrap:"wrap"}}>
                {modules.map(m=><button key={m} onClick={()=>setFilterMod(m)} style={{padding:"3px 7px",borderRadius:5,border:"none",background:filterMod===m?(MCOLORS[m]||"#1B2A4A"):"#f0f0f0",color:filterMod===m?"#fff":"#555",fontSize:9,fontWeight:700,cursor:"pointer"}}>{m==="All"?"All":m.split(" ")[0]}</button>)}
              </div>
              <div style={{maxHeight:190,overflowY:"auto",display:"grid",gap:4}}>
                {visibleTopics.map(t=><button key={t.id} onClick={()=>setCfg(c=>({...c,topic:t.id,topicLabel:t.label}))} style={{padding:"8px 10px",borderRadius:7,border:`1.5px solid ${cfg.topic===t.id?(MCOLORS[t.module]||"#1B2A4A"):"#e8e8e8"}`,background:cfg.topic===t.id?"#f8f5ff":"#fff",textAlign:"left",cursor:"pointer"}}>
                  <div style={{fontSize:12,fontWeight:cfg.topic===t.id?700:400,color:cfg.topic===t.id?(MCOLORS[t.module]||"#1B2A4A"):"#444"}}>{t.label}</div>
                  <div style={{fontSize:10,color:"#bbb"}}>{t.module}</div>
                </button>)}
              </div>
            </div>
          </div>
          <div>
            <button onClick={run} disabled={loading} style={{width:"100%",padding:"15px",borderRadius:12,border:"none",background:loading?"#ccc":"linear-gradient(135deg,#1B2A4A,#0D6E72)",color:"#fff",fontSize:14,fontWeight:900,cursor:loading?"not-allowed":"pointer",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"center",gap:10,boxShadow:loading?"none":"0 4px 18px rgba(27,42,74,0.3)"}}>
              {loading?(<><div style={{width:16,height:16,border:"2px solid rgba(255,255,255,0.4)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>Generating {cfg.count} question{cfg.count>1?"s":""}...</>)
                :`⚡ Generate ${cfg.count} ${cfg.topicLabel} — ${cfg.board} ${cfg.tier} ${cfg.diff}`}
            </button>
            {err&&<div style={{background:"#fff5f5",border:"1.5px solid #E74C3C",borderRadius:10,padding:"12px 16px",marginBottom:14,color:"#C0392B",fontSize:13}}>⚠ {err}</div>}
            {loading&&!qs.length&&<div style={{textAlign:"center",padding:"60px 20px",color:"#888"}}>
              <div style={{fontSize:40,marginBottom:12}}>⚡</div>
              <div style={{fontSize:15,fontWeight:700,color:"#1B2A4A",marginBottom:6}}>Writing your questions...</div>
              <div style={{fontSize:13}}>Creating {cfg.board}-style {cfg.diff} questions on {cfg.topicLabel}</div>
            </div>}
            {qs.length>0&&!loading&&<>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div style={{fontSize:11,fontWeight:800,color:"#888",textTransform:"uppercase",letterSpacing:1}}>{qs.length} question{qs.length>1?"s":""} generated</div>
                <button onClick={run} style={{background:"none",border:"1.5px solid #e0e0e0",borderRadius:8,padding:"6px 12px",fontSize:11,fontWeight:700,color:"#555",cursor:"pointer"}}>↺ Regenerate</button>
              </div>
              {qs.map((q,i)=><QCardGen key={`${total}-${i}`} q={q} idx={i} board={cfg.board}/>)}
            </>}
            {!qs.length&&!loading&&<div style={{textAlign:"center",padding:"60px 20px"}}>
              <div style={{fontSize:56,marginBottom:14}}>📐</div>
              <div style={{fontSize:16,fontWeight:800,color:"#1B2A4A",marginBottom:8}}>Ready to generate</div>
              <p style={{color:"#888",fontSize:13,maxWidth:300,margin:"0 auto",lineHeight:1.6}}>Choose your board, tier, topic and difficulty, then hit Generate.</p>
            </div>}
          </div>
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
