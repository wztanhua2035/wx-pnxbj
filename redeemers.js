'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
module.exports=function(directory){
 const file=path.join(directory,'lottery','redeemers.json');
 const read=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{accounts:[]};
 const write=db=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(db,null,2));fs.renameSync(file+'.tmp',file);};
 const publicRow=a=>({id:a.id,account:a.account,name:a.name,phone:a.phone,enabled:a.enabled,revision:a.revision});
 const error=m=>{const e=new Error(m);e.status=400;throw e;};
 const hash=(p,s)=>crypto.scryptSync(p,s,32).toString('hex');
 function save(b){
  const db=read();let a=b.id?db.accounts.find(x=>x.id===b.id):null;
  if(b.id&&!a)error('核销员不存在');
  const account=String(b.account||'').trim(),name=String(b.name||'').trim(),phone=String(b.phone||'').trim(),password=String(b.password||'');
  if(!/^[a-zA-Z0-9_-]{3,40}$/.test(account))error('账号需为3-40位字母、数字、下划线或短横线');
  if(!name||name.length>40||!/^\+?[0-9 -]{6,20}$/.test(phone))error('请填写姓名和有效手机号');
  if(db.accounts.some(x=>x.account.toLowerCase()===account.toLowerCase()&&x!==a))error('账号已存在');
  if((!a||password)&& (password.length<8||password.length>128))error('密码需为8-128位');
  if(!a){a={id:crypto.randomBytes(12).toString('hex'),revision:0};db.accounts.push(a);}
  Object.assign(a,{account,name,phone,enabled:b.enabled!==false,revision:a.revision+1});
  if(password){a.salt=crypto.randomBytes(16).toString('hex');a.hash=hash(password,a.salt);}
  write(db);return publicRow(a);
 }
 function login(account,password){
  const a=read().accounts.find(x=>x.account.toLowerCase()===String(account||'').trim().toLowerCase());
  const salt=a?a.salt:'00000000000000000000000000000000';const value=hash(String(password||'').slice(0,129),salt);
  if(!a||!a.enabled||!crypto.timingSafeEqual(Buffer.from(value,'hex'),Buffer.from(a.hash,'hex')))return null;
  return {subject:a.id+':'+a.revision,name:a.name};
 }
 function session(subject){const [id,rev]=String(subject).split(':');const a=read().accounts.find(x=>x.id===id&&x.enabled&&String(x.revision)===rev);return a?{id:a.id,name:a.name}:null;}
 return {list:()=>read().accounts.map(publicRow),save,login,session};
};
