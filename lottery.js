'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function clone(v){ return JSON.parse(JSON.stringify(v)); }
function ensureDir(file){ fs.mkdirSync(path.dirname(file), { recursive:true }); }
function atomicWrite(file,value){
  ensureDir(file);
  const tmp=file+'.tmp-'+process.pid+'-'+Date.now();
  fs.writeFileSync(tmp,JSON.stringify(value,null,2));
  fs.renameSync(tmp,file);
}
function readJson(file,fallback){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(e){return clone(typeof fallback==='function'?fallback():fallback);}
}
function fail(status,message){const e=new Error(message);e.status=status;throw e;}
function cleanText(v,max){return String(v==null?'':v).replace(/[\r\t]/g,' ').trim().slice(0,max);}
function cleanImage(v){const s=cleanText(v,800);return /^https:\/\//i.test(s)||/^\/media\/lottery\/[A-Za-z0-9_-]+\.(?:png|jpg)$/i.test(s)?s:'';}
function randomId(prefix){return (prefix||'id')+'_'+Date.now().toString(36)+'_'+crypto.randomBytes(3).toString('hex');}
function toTime(v){if(v==null||v==='')return 0;const n=Number(v);if(Number.isFinite(n))return n>0?Math.floor(n):0;const t=Date.parse(String(v));return Number.isFinite(t)&&t>0?t:0;}
function cleanDate(v){const s=cleanText(v,20);return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:'';}
function redeemDeadlineMs(date){const s=cleanDate(date);if(!s)return 0;const t=Date.parse(s+'T23:59:59.999+08:00');return Number.isFinite(t)?t:0;}
function isExpiredDate(date,at){const t=redeemDeadlineMs(date);return !!(t&&Number(at||Date.now())>t);}

module.exports=function createLotteryService(dataDir){
  const CONFIG_FILE=path.join(dataDir,'lottery','config.json');
  const STATE_FILE=path.join(dataDir,'lottery','state.json');
  const defaultProject=()=>({
    id:'project_default',
    name:'坡南礼遇抽奖',
    startAt:0,
    endAt:0,
    normalDraws:1,
    sDraws:2,
    maxUnredeemedTickets:5,
    maxWinsPerPlayer:5,
    redeemDeadline:'',
    redeemMethod:'',
    rules:'每次完整通关可抽奖1次，获得S级评价可抽奖2次。每位玩家在本活动中的获奖次数以上限设置为准，奖券须凭8位兑换码核销。',
    prizes:[],
    updatedAt:0
  });
  const defaultConfig=()=>({enabled:false,activeProjectId:'',projects:[],updatedAt:0});
  const defaultState=()=>({tickets:[],usageByUser:{},updatedAt:0});

  function sanitizePrize(raw,previous){
    const p=raw&&typeof raw==='object'?raw:{};
    const id=cleanText(p.id,80)||randomId('prize');
    const total=Math.max(0,Math.min(1000000,Math.floor(Number(p.totalQuantity!=null?p.totalQuantity:(p.quantity!=null?p.quantity:previous&&previous.totalQuantity))||0)));
    const remainingInput=p.remainingQuantity!=null?p.remainingQuantity:(previous?previous.remainingQuantity:total);
    return {
      id,
      awardName:cleanText(p.awardName,60)||cleanText(previous&&previous.awardName,60)||'',
      name:cleanText(p.name,80)||'未命名奖品',
      imageUrl:cleanImage(p.imageUrl),
      totalQuantity:total,
      remainingQuantity:Math.max(0,Math.min(total,Math.floor(Number(remainingInput)||0))),
      probability:Math.round(Math.max(0,Math.min(100,Number(p.probability)||0))*10000)/10000,
      note:cleanText(p.note,300)
    };
  }

  function sanitizeProject(raw,previous){
    const p=raw&&typeof raw==='object'?raw:{};
    const prev=previous||{};
    const prevById=new Map((prev.prizes||[]).map(x=>[x.id,x]));
    const source=Array.isArray(p.prizes)?p.prizes:(prev.prizes||[]);
    if(source.length>30)fail(400,'每个抽奖项目最多设置30个奖项');
    const ids=new Set();
    const prizes=source.map(item=>{
      const prize=sanitizePrize(item,prevById.get(item&&item.id));
      if(ids.has(prize.id))fail(400,'同一抽奖项目内奖项ID不能重复');
      ids.add(prize.id);return prize;
    });
    const probabilityTotal=prizes.reduce((s,x)=>s+x.probability,0);
    if(probabilityTotal>100.000001)fail(400,'同一抽奖项目所有奖项的中奖概率合计不能超过100%');
    const project={
      id:cleanText(p.id,80)||cleanText(prev.id,80)||randomId('project'),
      name:cleanText(p.name,100)||cleanText(prev.name,100)||'未命名抽奖项目',
      startAt:toTime(p.startAt!=null?p.startAt:prev.startAt),
      endAt:toTime(p.endAt!=null?p.endAt:prev.endAt),
      normalDraws:p.normalDraws==null?(prev.normalDraws==null?1:Number(prev.normalDraws)):Number(p.normalDraws),
      sDraws:p.sDraws==null?(prev.sDraws==null?2:Number(prev.sDraws)):Number(p.sDraws),
      maxUnredeemedTickets:p.maxUnredeemedTickets==null?(prev.maxUnredeemedTickets==null?5:Number(prev.maxUnredeemedTickets)):Number(p.maxUnredeemedTickets),
      maxWinsPerPlayer:p.maxWinsPerPlayer==null?(prev.maxWinsPerPlayer==null?5:Number(prev.maxWinsPerPlayer)):Number(p.maxWinsPerPlayer),
      redeemDeadline:cleanDate(p.redeemDeadline!=null?p.redeemDeadline:prev.redeemDeadline),
      redeemMethod:p.redeemMethod!=null?cleanText(p.redeemMethod,500):cleanText(prev.redeemMethod,500),
      rules:p.rules!=null?cleanText(p.rules,5000):cleanText(prev.rules,5000),
      prizes,
      updatedAt:Date.now()
    };
    if(![project.normalDraws,project.sDraws].every(n=>Number.isInteger(n)&&n>=0&&n<=100))fail(400,'抽奖次数必须为0-100的整数');
    if(!Number.isInteger(project.maxUnredeemedTickets)||project.maxUnredeemedTickets<1||project.maxUnredeemedTickets>50)fail(400,'未兑换奖券上限必须为1-50的整数');
    if(!Number.isInteger(project.maxWinsPerPlayer)||project.maxWinsPerPlayer<1||project.maxWinsPerPlayer>100)fail(400,'每位玩家获奖最高次数必须为1-100的整数');
    if(project.startAt&&project.endAt&&project.endAt<=project.startAt)fail(400,'抽奖截止时间必须晚于开始时间');
    return project;
  }

  function migrateLegacyConfig(raw){
    if(raw&&Array.isArray(raw.projects))return raw;
    const old=raw&&typeof raw==='object'?raw:{};
    const p=defaultProject();
    p.name=cleanText(old.projectName,100)||'坡南礼遇抽奖';
    p.normalDraws=Number.isInteger(Number(old.normalDraws))?Number(old.normalDraws):1;
    p.sDraws=Number.isInteger(Number(old.sDraws))?Number(old.sDraws):2;
    p.maxUnredeemedTickets=Number.isInteger(Number(old.maxUnredeemedTickets))?Number(old.maxUnredeemedTickets):5;
    p.maxWinsPerPlayer=5;
    p.redeemDeadline=cleanDate(old.redeemDeadline);
    p.redeemMethod=cleanText(old.redeemMethod,500);
    p.rules=cleanText(old.rules,5000)||p.rules;
    p.prizes=Array.isArray(old.prizes)?old.prizes:[];
    p.updatedAt=Number(old.updatedAt)||0;
    return {enabled:!!old.enabled,activeProjectId:p.id,projects:[p],updatedAt:Number(old.updatedAt)||0};
  }

  function getConfig(){
    const raw=migrateLegacyConfig(readJson(CONFIG_FILE,defaultConfig));
    const oldProjects=Array.isArray(raw.projects)?raw.projects:[];
    const seen=new Set();
    const projects=[];
    oldProjects.forEach(item=>{
      const p=sanitizeProject(item,item);
      if(!seen.has(p.id)){seen.add(p.id);projects.push(p);}
    });
    const activeProjectId=cleanText(raw.activeProjectId,80);
    return {enabled:!!raw.enabled,activeProjectId:projects.some(p=>p.id===activeProjectId)?activeProjectId:'',projects,updatedAt:Number(raw.updatedAt)||0};
  }

  function activeProject(cfg){
    return (cfg.projects||[]).find(p=>p.id===cfg.activeProjectId)||null;
  }

  function projectPhase(project,at){
    const t=Number(at)||Date.now();
    if(!project)return {active:false,code:'NO_PROJECT',reason:'当前没有选择生效的抽奖项目'};
    if(project.startAt&&t<project.startAt)return {active:false,code:'NOT_STARTED',reason:'抽奖活动尚未开始'};
    if(project.endAt&&t>project.endAt)return {active:false,code:'ENDED',reason:'抽奖活动已结束'};
    return {active:true,code:'ACTIVE',reason:''};
  }

  function publicConfig(){
    const cfg=getConfig(),project=activeProject(cfg),phase=projectPhase(project,Date.now());
    if(!cfg.enabled)return {enabled:false,activityActive:false,eligibilityReason:'抽奖功能暂未开启',eligibilityCode:'DISABLED'};
    if(!project)return {enabled:true,activityActive:false,eligibilityReason:phase.reason,eligibilityCode:phase.code,project:null,prizes:[]};
    return {
      enabled:true,
      activityActive:phase.active,
      eligibilityReason:phase.reason,
      eligibilityCode:phase.code,
      project:{id:project.id,name:project.name,startAt:project.startAt,endAt:project.endAt,maxWinsPerPlayer:project.maxWinsPerPlayer,redeemDeadline:project.redeemDeadline||'',redeemMethod:project.redeemMethod||''},
      projectId:project.id,
      projectName:project.name,
      startAt:project.startAt,endAt:project.endAt,
      rules:project.rules,normalDraws:project.normalDraws,sDraws:project.sDraws,
      maxUnredeemedTickets:project.maxUnredeemedTickets,maxWinsPerPlayer:project.maxWinsPerPlayer,
      redeemDeadline:project.redeemDeadline||'',redeemMethod:project.redeemMethod||'',
      prizes:project.prizes.map(p=>({id:p.id,awardName:p.awardName||'',name:p.name,imageUrl:p.imageUrl,remainingQuantity:p.remainingQuantity,probability:p.probability,note:p.note}))
    };
  }

  function writeConfig(input){
    const body=input&&typeof input==='object'?input:{},old=getConfig(),oldById=new Map(old.projects.map(p=>[p.id,p]));
    const source=Array.isArray(body.projects)?body.projects:old.projects;
    if(source.length>50)fail(400,'抽奖项目最多保留50个');
    const ids=new Set();
    const projects=source.map(raw=>{
      const id=cleanText(raw&&raw.id,80);
      const p=sanitizeProject(raw,id?oldById.get(id):null);
      if(ids.has(p.id))fail(400,'抽奖项目ID不能重复');ids.add(p.id);return p;
    });
    let activeProjectId=body.activeProjectId!=null?cleanText(body.activeProjectId,80):old.activeProjectId;
    if(activeProjectId&&!projects.some(p=>p.id===activeProjectId))fail(400,'选择生效的抽奖项目不存在');
    const next={enabled:body.enabled!=null?!!body.enabled:!!old.enabled,activeProjectId,projects,updatedAt:Date.now()};
    atomicWrite(CONFIG_FILE,next);return next;
  }

  function readState(){
    const s=Object.assign(defaultState(),readJson(STATE_FILE,defaultState));
    if(!Array.isArray(s.tickets))s.tickets=[];
    if(!s.usageByUser||typeof s.usageByUser!=='object')s.usageByUser={};
    return s;
  }
  function writeState(s){s.updatedAt=Date.now();atomicWrite(STATE_FILE,s);}
  function realProfile(p){
    const name=cleanText(p&&(p.displayName||p.nickName),80),avatar=cleanImage(p&&p.avatarUrl);
    return !!(avatar&&name&&name!=='微信用户'&&name!=='微信玩家'&&!/^寻宝客/.test(name));
  }
  function scoreOf(save){
    const s=save||{},best=s.bestScores&&typeof s.bestScores==='object'?s.bestScores:{};
    let total=Object.values(best).reduce((sum,v)=>sum+Math.max(0,Number(v)||0),0);
    if(!best['1']&&!best[1])total+=Math.max(0,Number(s.stage1Best)||0);
    return Math.floor(total);
  }
  function ticketPublic(t,cfg){
    let deadline=cleanDate(t.redeemDeadline),method=cleanText(t.redeemMethod,500);
    if((!deadline||!method)&&cfg){const p=(cfg.projects||[]).find(x=>String(x.id)===String(t.projectId||'project_default'));if(p){if(!deadline)deadline=cleanDate(p.redeemDeadline);if(!method)method=cleanText(p.redeemMethod,500);}}
    const expired=!t.debug&&!t.redeemed&&isExpiredDate(deadline,Date.now());
    return {id:t.id,code:t.code,projectId:t.projectId||'',projectName:t.projectName||'',prizeId:t.prizeId,awardName:t.awardName||'',prizeName:t.prizeName,imageUrl:t.imageUrl||'',note:t.note||'',redeemDeadline:deadline,redeemMethod:method,expired,debug:!!t.debug,invalid:!!t.debug,redeemed:!!t.redeemed,createdAt:t.createdAt||0,redeemedAt:t.redeemedAt||0};
  }
  function usageBucket(state,userId,projectId){
    if(!state.usageByUser[userId]||typeof state.usageByUser[userId]!=='object')state.usageByUser[userId]={};
    const root=state.usageByUser[userId];
    if(!root[projectId]||typeof root[projectId]!=='object')root[projectId]={};
    return root[projectId];
  }
  function usedDraws(state,userId,projectId,completionKey){
    const root=state.usageByUser[userId]&&typeof state.usageByUser[userId]==='object'?state.usageByUser[userId]:{};
    const bucket=root[projectId]&&typeof root[projectId]==='object'?root[projectId]:{};
    if(Object.prototype.hasOwnProperty.call(bucket,completionKey))return Math.max(0,Math.floor(Number(bucket[completionKey])||0));
    // 旧版只有 userId -> completionKey 的结构；默认迁移项目继续继承已用次数，避免升级后重复获得机会。
    if(projectId==='project_default'&&Object.prototype.hasOwnProperty.call(root,completionKey)&&typeof root[completionKey]!=='object')return Math.max(0,Math.floor(Number(root[completionKey])||0));
    return 0;
  }

  function status(args){
    const a=args||{},cfg=getConfig(),project=activeProject(cfg),phase=projectPhase(project,Date.now()),state=readState(),userId=String(a.userId||''),save=a.save||{},score=scoreOf(save),grade=score>=21000?'S':score>=18000?'A':score>=15000?'B':score>=12000?'C':score>=8000?'D':'E';
    const completed=!!save.gameCompleted&&Number(save.gameCompletedAt)>0,completionKey=completed?String(Math.floor(Number(save.gameCompletedAt))):'';
    const allowed=completed&&project?(grade==='S'?project.sDraws:project.normalDraws):0;
    const usage=project?usageBucket(state,userId,project.id):{};
    const used=usedDraws(state,userId,project.id,completionKey);
    const allTickets=state.tickets.filter(t=>String(t.userId)===userId).sort((x,y)=>Number(y.createdAt)-Number(x.createdAt));
    const projectTickets=project?allTickets.filter(t=>String(t.projectId||'project_default')===String(project.id)):[];
    const formalCount=projectTickets.filter(t=>!t.debug).length;
    const pendingCount=projectTickets.filter(t=>!t.debug&&!t.redeemed).length;
    const profileReady=realProfile(a.profile),debugMode=!!a.debugMode;
    const maxWins=project?project.maxWinsPerPlayer:0;
    const pendingLimit=project?project.maxUnredeemedTickets:5;
    let reason='',code='OK';
    if(!cfg.enabled){reason='抽奖功能暂未开启';code='DISABLED';}
    else if(!project){reason='当前没有选择生效的抽奖项目';code='NO_PROJECT';}
    else if(!phase.active){reason=phase.reason;code=phase.code;}
    else if(!profileReady){reason='请先获取并保存微信头像和昵称';code='PROFILE_REQUIRED';}
    else if(!completed){reason='请先完整通关并同步云存档';code='NOT_COMPLETED';}
    else if(formalCount>=maxWins){reason=`本活动每位玩家最多可获奖${maxWins}次，您已达到上限`;code='WIN_LIMIT';}
    else if(pendingCount>=pendingLimit){reason=`您已有${pendingCount}张未兑换奖券，请先领取奖品后再抽奖`;code='PENDING_LIMIT';}
    else if(Math.max(0,allowed-used)<=0){reason='本次通关的抽奖次数已用完，重新通关后可再次获得机会';code='DRAW_USED';}
    const drawsRemaining=code==='OK'?Math.max(0,allowed-used):0;
    return Object.assign(publicConfig(),{
      profileReady,completed,grade,score,drawsAllowed:allowed,drawsUsed:used,drawsRemaining,
      eligibilityReason:reason,eligibilityCode:code,canDraw:code==='OK',
      prizeLimit:maxWins,prizeCount:formalCount,pendingPrizeCount:pendingCount,maxUnredeemedTickets:pendingLimit,pendingLimitReached:pendingCount>=pendingLimit,
      debugMode,debugUnlimited:!!(cfg.enabled&&project&&debugMode),tickets:allTickets.map(t=>ticketPublic(t,cfg))
    });
  }

  function uniqueCode(state){
    const used=new Set(state.tickets.map(t=>String(t.code)));
    for(let i=0;i<100;i++){const code=String(crypto.randomInt(0,100000000)).padStart(8,'0');if(!used.has(code))return code;}
    fail(503,'暂时无法生成兑奖码，请重试');
  }
  function pickPrize(project,debug){
    const r=crypto.randomInt(0,100000000)/1000000;let cursor=0;
    for(const p of project.prizes){cursor+=p.probability;if(r<cursor)return (debug||p.remainingQuantity>0)?p:null;}
    return null;
  }
  function draw(args){
    const a=args||{},cfg=getConfig(),project=activeProject(cfg),phase=projectPhase(project,Date.now());
    if(!cfg.enabled)fail(403,'抽奖功能暂未开启');
    if(!project)fail(409,'当前没有选择生效的抽奖项目');
    if(!phase.active)fail(409,phase.reason);
    const debug=!!a.debug;
    if(debug&&!a.debugMode)fail(403,'调试抽奖未开启');
    if(!realProfile(a.profile))fail(409,'请先获取并保存微信头像和昵称');
    const before=status(a);
    if(!debug&&!before.canDraw)fail(409,before.eligibilityReason||'当前不能抽奖');
    const state=readState(),userId=String(a.userId||''),prize=pickPrize(project,debug);
    if(!debug){
      const completionKey=String(Math.floor(Number((a.save||{}).gameCompletedAt)));
      const usage=usageBucket(state,userId,project.id);
      usage[completionKey]=usedDraws(state,userId,project.id,completionKey)+1;
    }
    let ticket=null;
    if(prize){
      ticket={id:'ticket_'+Date.now().toString(36)+'_'+crypto.randomBytes(4).toString('hex'),code:uniqueCode(state),userId,projectId:project.id,projectName:project.name,prizeId:prize.id,awardName:prize.awardName||'',prizeName:prize.name,imageUrl:prize.imageUrl||'',note:prize.note||'',redeemDeadline:project.redeemDeadline||'',redeemMethod:project.redeemMethod||'',debug,redeemed:false,createdAt:Date.now(),redeemedAt:0};
      state.tickets.push(ticket);
      if(!debug){
        const live=project.prizes.find(p=>p.id===prize.id);
        if(live){live.remainingQuantity=Math.max(0,live.remainingQuantity-1);cfg.updatedAt=Date.now();const target=cfg.projects.find(p=>p.id===project.id);if(target)Object.assign(target,project);atomicWrite(CONFIG_FILE,cfg);}
      }
    }
    writeState(state);
    return {ok:true,won:!!ticket,prize:ticket?{id:ticket.prizeId,awardName:ticket.awardName||'',name:ticket.prizeName,imageUrl:ticket.imageUrl,note:ticket.note,redeemDeadline:ticket.redeemDeadline||'',redeemMethod:ticket.redeemMethod||''}:null,ticket:ticket?ticketPublic(ticket,cfg):null,status:status(a)};
  }
  function clearDebug(userId){
    const state=readState(),before=state.tickets.length;
    state.tickets=state.tickets.filter(t=>!(String(t.userId)===String(userId)&&t.debug));
    const removed=before-state.tickets.length;if(removed)writeState(state);return {ok:true,removed};
  }
  function findTicket(code){
    const state=readState(),ticket=state.tickets.find(t=>String(t.code)===String(code||'').trim());
    const cfg=getConfig();return ticket?ticketPublic(ticket,cfg):null;
  }
  function redeem(code,actor){
    const state=readState(),ticket=state.tickets.find(t=>String(t.code)===String(code||'').trim());
    if(!ticket)fail(404,'未找到该兑奖码');
    if(ticket.debug)fail(409,'调试奖券无效，不能核销');
    const cfg=getConfig(),publicTicket=ticketPublic(ticket,cfg);
    if(publicTicket.expired)fail(409,'该奖券兑奖期限已过，不能核销');
    const alreadyRedeemed=!!ticket.redeemed;
    if(!alreadyRedeemed){ticket.redeemed=true;ticket.redeemedAt=Date.now();ticket.redeemedBy=actor||{id:'admin',name:'管理员'};writeState(state);}
    return {ok:true,alreadyRedeemed,ticket:ticketPublic(ticket,cfg)};
  }
  function summary(){
    const s=readState(),formal=s.tickets.filter(t=>!t.debug),debug=s.tickets.filter(t=>t.debug),cfg=getConfig(),project=activeProject(cfg);
    return {formalTickets:formal.length,redeemed:formal.filter(t=>t.redeemed).length,debugTickets:debug.length,lotteryProjects:cfg.projects.length,activeLotteryProject:project?project.name:''};
  }

  ensureDir(CONFIG_FILE);ensureDir(STATE_FILE);
  return {getConfig,publicConfig,writeConfig,status,draw,clearDebug,findTicket,redeem,summary};
};
