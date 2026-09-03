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
function cleanImage(v){const s=cleanText(v,800);return /^https:\/\//i.test(s)?s:'';}
function randomId(){return 'prize_'+Date.now().toString(36)+'_'+crypto.randomBytes(3).toString('hex');}

module.exports=function createLotteryService(dataDir){
  const CONFIG_FILE=path.join(dataDir,'lottery','config.json');
  const STATE_FILE=path.join(dataDir,'lottery','state.json');
  const defaultConfig=()=>({
    enabled:false,
    rules:'每次完整通关可抽奖1次，获得S级评价可抽奖2次。每位玩家最多获得5件正式奖品，奖券须凭8位兑换码核销。',
    prizes:[],
    updatedAt:0
  });
  const defaultState=()=>({tickets:[],usageByUser:{},updatedAt:0});

  function getConfig(){
    const c=Object.assign(defaultConfig(),readJson(CONFIG_FILE,defaultConfig));
    if(!Array.isArray(c.prizes))c.prizes=[];
    c.prizes=c.prizes.map(p=>({
      id:cleanText(p&&p.id,80)||randomId(),
      name:cleanText(p&&p.name,80)||'未命名奖品',
      imageUrl:cleanImage(p&&p.imageUrl),
      totalQuantity:Math.max(0,Math.floor(Number(p&&p.totalQuantity)||0)),
      remainingQuantity:Math.max(0,Math.floor(Number(p&&p.remainingQuantity)||0)),
      probability:Math.max(0,Math.min(100,Number(p&&p.probability)||0)),
      note:cleanText(p&&p.note,300)
    }));
    return c;
  }

  function publicConfig(){
    const c=getConfig();
    if(!c.enabled)return {enabled:false};
    return {enabled:true,rules:c.rules,prizes:c.prizes.map(p=>({id:p.id,name:p.name,imageUrl:p.imageUrl,remainingQuantity:p.remainingQuantity,note:p.note}))};
  }

  function writeConfig(input){
    const body=input&&typeof input==='object'?input:{},old=getConfig(),oldById=new Map(old.prizes.map(p=>[p.id,p]));
    const source=Array.isArray(body.prizes)?body.prizes:old.prizes;
    if(source.length>30)fail(400,'奖项最多设置30个');
    const ids=new Set();
    const prizes=source.map(raw=>{
      const p=raw&&typeof raw==='object'?raw:{},id=cleanText(p.id,80)||randomId();
      if(ids.has(id))fail(400,'奖项ID不能重复');ids.add(id);
      const previous=oldById.get(id),total=Math.max(0,Math.min(1000000,Math.floor(Number(p.totalQuantity!=null?p.totalQuantity:(p.quantity!=null?p.quantity:previous&&previous.totalQuantity))||0)));
      const remainingInput=p.remainingQuantity!=null?p.remainingQuantity:(previous?previous.remainingQuantity:total);
      return {
        id,
        name:cleanText(p.name,80)||'未命名奖品',
        imageUrl:cleanImage(p.imageUrl),
        totalQuantity:total,
        remainingQuantity:Math.max(0,Math.min(total,Math.floor(Number(remainingInput)||0))),
        probability:Math.round(Math.max(0,Math.min(100,Number(p.probability)||0))*10000)/10000,
        note:cleanText(p.note,300)
      };
    });
    const probabilityTotal=prizes.reduce((s,p)=>s+p.probability,0);
    if(probabilityTotal>100.000001)fail(400,'所有奖项的中奖概率合计不能超过100%');
    const next={
      enabled:body.enabled!=null?!!body.enabled:!!old.enabled,
      rules:body.rules!=null?cleanText(body.rules,5000):old.rules,
      prizes,
      updatedAt:Date.now()
    };
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
  function ticketPublic(t){
    return {id:t.id,code:t.code,prizeId:t.prizeId,prizeName:t.prizeName,imageUrl:t.imageUrl||'',note:t.note||'',debug:!!t.debug,invalid:!!t.debug,redeemed:!!t.redeemed,createdAt:t.createdAt||0,redeemedAt:t.redeemedAt||0};
  }
  function status(args){
    const a=args||{},cfg=getConfig(),state=readState(),userId=String(a.userId||''),save=a.save||{},score=scoreOf(save),grade=score>=21000?'S':score>=18000?'A':score>=15000?'B':score>=12000?'C':score>=8000?'D':'E';
    const completed=!!save.gameCompleted&&Number(save.gameCompletedAt)>0,completionKey=completed?String(Math.floor(Number(save.gameCompletedAt))):'',allowed=completed?(grade==='S'?2:1):0;
    const usage=state.usageByUser[userId]||{},used=Math.max(0,Math.floor(Number(usage[completionKey])||0));
    const tickets=state.tickets.filter(t=>String(t.userId)===userId).sort((x,y)=>Number(y.createdAt)-Number(x.createdAt));
    const formalCount=tickets.filter(t=>!t.debug).length,profileReady=realProfile(a.profile),debugMode=!!a.debugMode;
    return Object.assign(publicConfig(),{
      profileReady,completed,grade,score,drawsAllowed:allowed,drawsUsed:used,
      drawsRemaining:cfg.enabled&&profileReady&&completed&&formalCount<5?Math.max(0,allowed-used):0,
      prizeLimit:5,prizeCount:formalCount,debugMode,debugUnlimited:!!(cfg.enabled&&debugMode),tickets:tickets.map(ticketPublic)
    });
  }
  function uniqueCode(state){
    const used=new Set(state.tickets.map(t=>String(t.code)));
    for(let i=0;i<100;i++){const code=String(crypto.randomInt(0,100000000)).padStart(8,'0');if(!used.has(code))return code;}
    fail(503,'暂时无法生成兑奖码，请重试');
  }
  function pickPrize(cfg,debug){
    const r=crypto.randomInt(0,100000000)/1000000;let cursor=0;
    for(const p of cfg.prizes){cursor+=p.probability;if(r<cursor)return (debug||p.remainingQuantity>0)?p:null;}
    return null;
  }
  function draw(args){
    const a=args||{},cfg=getConfig();if(!cfg.enabled)fail(403,'抽奖功能暂未开启');
    const debug=!!a.debug;
    if(debug&&!a.debugMode)fail(403,'调试抽奖未开启');
    if(!realProfile(a.profile))fail(409,'请先获取并保存微信头像和昵称');
    const before=status(a);
    if(!debug){
      if(!before.completed)fail(409,'请先完整通关并同步云存档');
      if(before.prizeCount>=5)fail(409,'每位玩家最多获得5件奖品');
      if(before.drawsRemaining<=0)fail(409,'本次通关的抽奖次数已用完');
    }
    const state=readState(),userId=String(a.userId||''),prize=pickPrize(cfg,debug);
    if(!debug){
      const completionKey=String(Math.floor(Number((a.save||{}).gameCompletedAt)));
      if(!state.usageByUser[userId])state.usageByUser[userId]={};
      state.usageByUser[userId][completionKey]=Math.max(0,Math.floor(Number(state.usageByUser[userId][completionKey])||0))+1;
    }
    let ticket=null;
    if(prize){
      ticket={id:'ticket_'+Date.now().toString(36)+'_'+crypto.randomBytes(4).toString('hex'),code:uniqueCode(state),userId,prizeId:prize.id,prizeName:prize.name,imageUrl:prize.imageUrl||'',note:prize.note||'',debug,redeemed:false,createdAt:Date.now(),redeemedAt:0};
      state.tickets.push(ticket);
      if(!debug){const live=cfg.prizes.find(p=>p.id===prize.id);if(live){live.remainingQuantity=Math.max(0,live.remainingQuantity-1);cfg.updatedAt=Date.now();atomicWrite(CONFIG_FILE,cfg);}}
    }
    writeState(state);
    return {ok:true,won:!!ticket,prize:ticket?{id:ticket.prizeId,name:ticket.prizeName,imageUrl:ticket.imageUrl,note:ticket.note}:null,ticket:ticket?ticketPublic(ticket):null,status:status(a)};
  }
  function clearDebug(userId){
    const state=readState(),before=state.tickets.length;
    state.tickets=state.tickets.filter(t=>!(String(t.userId)===String(userId)&&t.debug));
    const removed=before-state.tickets.length;if(removed)writeState(state);return {ok:true,removed};
  }
  function findTicket(code){
    const state=readState(),ticket=state.tickets.find(t=>String(t.code)===String(code||'').trim());
    return ticket?ticketPublic(ticket):null;
  }
  function redeem(code){
    const state=readState(),ticket=state.tickets.find(t=>String(t.code)===String(code||'').trim());
    if(!ticket)fail(404,'未找到该兑奖码');
    if(ticket.debug)fail(409,'调试奖券无效，不能核销');
    const alreadyRedeemed=!!ticket.redeemed;
    if(!alreadyRedeemed){ticket.redeemed=true;ticket.redeemedAt=Date.now();writeState(state);}
    return {ok:true,alreadyRedeemed,ticket:ticketPublic(ticket)};
  }
  function summary(){
    const s=readState(),formal=s.tickets.filter(t=>!t.debug),debug=s.tickets.filter(t=>t.debug);
    return {formalTickets:formal.length,redeemed:formal.filter(t=>t.redeemed).length,debugTickets:debug.length};
  }

  ensureDir(CONFIG_FILE);ensureDir(STATE_FILE);
  return {getConfig,publicConfig,writeConfig,status,draw,clearDebug,findTicket,redeem,summary};
};
