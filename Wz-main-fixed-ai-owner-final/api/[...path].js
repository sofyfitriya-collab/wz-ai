const { Pool } = require('pg');
const crypto = require('crypto');
const webpush = require('web-push');

let pool;
function databaseUrl(){
  return process.env.WZDATABASE||process.env.DATABASE_URL||process.env.POSTGRES_URL||process.env.POSTGRES_URL_NON_POOLING||process.env.NEON_DATABASE_URL;
}
function getPool(){
  const url=databaseUrl();
  if(!url) throw new Error('Environment variable database belum dikonfigurasi di Vercel. Gunakan WZDATABASE, DATABASE_URL, atau POSTGRES_URL.');
  if(!pool) pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:5,connectionTimeoutMillis:10000,idleTimeoutMillis:30000});
  return pool;
}

function hashPassword(password, salt=crypto.randomBytes(16).toString('hex')){
  const hash=crypto.scryptSync(String(password),salt,64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored){
  try{
    const [salt,hex]=String(stored).split(':');
    const a=Buffer.from(hex,'hex');
    const b=crypto.scryptSync(String(password),salt,64);
    return a.length===b.length && crypto.timingSafeEqual(a,b);
  }catch{return false}
}
function token(){return crypto.randomBytes(32).toString('hex')}
function tokenHash(t){return crypto.createHash('sha256').update(t).digest('hex')}
function defaultUsername(name){return String(name||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'')||'employee'}
function defaultPassword(name){return String(name||'').trim().toLowerCase().replace(/\s+/g,'')+'123'}
function safeServerError(error){
  const message = error && error.message ? String(error.message) : 'Server error';
  return process.env.NODE_ENV === 'production' ? 'Server sedang tidak tersedia. Silakan coba lagi nanti.' : message;
}
function pushConfigured(){return !!(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY&&process.env.VAPID_SUBJECT)}
function localAiEnabled(){return String(process.env.WZ_USE_LOCAL_AI || 'true').toLowerCase() !== 'false';}
function missingRequiredConfig(){
  const missing=[];
  if(!pushConfigured())missing.push('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT');
  return missing;
}
function localAiAnswer(question,data){
  const q=String(question||'').toLowerCase();
  const summary=data?.summary||{};
  const totalOmzet=Number(summary.omzetPOS||0)+Number(summary.omzetShift||0);
  const topKaryawan=(data?.topKaryawan||[]).slice(0,3).map(([name,value])=>`${name}: Rp${Number(value).toLocaleString('id-ID')}`).join('; ')||'tidak ada data';
  const layanan=(data?.layananTerjual||[]).slice(0,3).map(([name,value])=>`${name}: ${value}`).join('; ')||'tidak ada data';
  const produk=(data?.produkTerjual||[]).slice(0,3).map(([name,value])=>`${name}: ${value}`).join('; ')||'tidak ada data';
  const cabang=(data?.omzetPerCabang||[]).slice(0,3).map(([name,value])=>`${name}: Rp${Number(value).toLocaleString('id-ID')}`).join('; ')||'tidak ada data';
  const pengeluaran=Number(summary.pengeluaranTotal||0);
  if(/omzet|penjualan|pendapatan|revenue|income/.test(q)){
    return `Berdasarkan data WZ pada scope ${data?.scope||'ALL'}, total omzet saat ini sekitar Rp${Number(totalOmzet).toLocaleString('id-ID')}. Komposisi dari POS dan tutup shift menunjukkan penjualan paling kuat di cabang/pegawai berikut: ${cabang}.`;
  }
  if(/karyawan|pegawai|perform|produk|services|layanan/.test(q)){
    return `Kinerja karyawan tertinggi berdasarkan data: ${topKaryawan}. Layanan paling sering terjual: ${layanan}. Produk paling laris: ${produk}.`;
  }
  if(/pengeluaran|biaya|expense/.test(q)){
    return `Total pengeluaran yang tercatat sebesar Rp${Number(pengeluaran).toLocaleString('id-ID')}. Ini mencakup pengeluaran shift dan pengeluaran umum dari data WZ yang tersedia.`;
  }
  if(/cabang|branch/.test(q)){
    return `Distribusi omzet per cabang: ${cabang}.`;
  }
  return `Berdasarkan data WZ yang tersedia pada scope ${data?.scope||'ALL'}, total transaksi tercatat ${summary.transactions||0}, laporan shift ${summary.shiftReports||0}, dan total omzet sekitar Rp${Number(totalOmzet).toLocaleString('id-ID')}. Karyawan terbaik: ${topKaryawan}.`;
}
async function sendShiftPushes(report,senderId){
  if(!pushConfigured())return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT,process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
  const p=getPool(),recipients=await p.query('SELECT s.id,s.endpoint,s.p256dh,s.auth FROM wz_push_subscriptions s JOIN wz_users u ON u.id=s.user_id WHERE u.active=true AND s.user_id<>$1',[senderId]);
  const payload=JSON.stringify({title:'WZ MANAGE PRO',body:`Laporan shift ${report.employeeName||report.employeeId||''} tersedia.`,icon:'/public/notification-icon-96.png',badge:'/public/notification-icon-24.png',tag:`wz-shift-${report.id}`,url:'/'});
  await Promise.all(recipients.rows.map(async subscription=>{
    try{await webpush.sendNotification({endpoint:subscription.endpoint,keys:{p256dh:subscription.p256dh,auth:subscription.auth}},payload,{TTL:86400});}
    catch(error){if(error.statusCode===404||error.statusCode===410)await p.query('DELETE FROM wz_push_subscriptions WHERE id=$1',[subscription.id]);}
  }));
}
async function createShiftNotifications(client,report,senderId){
  await client.query(`INSERT INTO wz_notifications(user_id,kind,reference_id,title,message,created_at) SELECT u.id,'SHIFT_REPORT',$1,$2,$3,NOW() FROM wz_users u WHERE u.active=true AND u.role IN ('owner','manager') AND u.id<>$4 ON CONFLICT(user_id,kind,reference_id) DO NOTHING`,[String(report.id),'Laporan shift tersimpan',`Laporan shift ${report.employeeName||report.employeeId||''} tanggal ${report.date} tersedia.`,senderId]);
}

let schemaPromise;
async function schema(){
  const p=getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS wz_branches(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS wz_employees(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'Barber',branch_id TEXT REFERENCES wz_branches(id),
      salary NUMERIC NOT NULL DEFAULT 0,commission NUMERIC NOT NULL DEFAULT 0,target NUMERIC NOT NULL DEFAULT 0,
      attendance NUMERIC NOT NULL DEFAULT 0,eval NUMERIC NOT NULL DEFAULT 0,active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wz_users(
      id BIGSERIAL PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL,
      name TEXT NOT NULL,employee_id TEXT UNIQUE REFERENCES wz_employees(id) ON DELETE SET NULL,active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wz_sessions(
      token_hash TEXT PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES wz_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS wz_sessions_exp_idx ON wz_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS wz_transactions(
      id TEXT PRIMARY KEY,date DATE NOT NULL,customer_id TEXT,customer_name TEXT,service_id TEXT,service_name TEXT,
      service_price NUMERIC NOT NULL DEFAULT 0,employee_id TEXT,employee_name TEXT,total NUMERIC NOT NULL DEFAULT 0,
      payment TEXT NOT NULL,status TEXT NOT NULL,discount NUMERIC NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS wz_transactions_date_idx ON wz_transactions(date);
    CREATE INDEX IF NOT EXISTS wz_transactions_employee_idx ON wz_transactions(employee_id);
    CREATE TABLE IF NOT EXISTS wz_shift_reports(
      id TEXT PRIMARY KEY,date DATE NOT NULL,employee_id TEXT,employee_name TEXT,shift_type TEXT,customers INTEGER NOT NULL DEFAULT 0,
      opening_cash NUMERIC NOT NULL DEFAULT 0,cash NUMERIC NOT NULL DEFAULT 0,qris NUMERIC NOT NULL DEFAULT 0,cash_expense NUMERIC NOT NULL DEFAULT 0,
      physical_cash NUMERIC NOT NULL DEFAULT 0,total_payment NUMERIC NOT NULL DEFAULT 0,expected_cash NUMERIC NOT NULL DEFAULT 0,cash_difference NUMERIC NOT NULL DEFAULT 0,
      service_total NUMERIC NOT NULL DEFAULT 0,product_total NUMERIC NOT NULL DEFAULT 0,total_omzet NUMERIC NOT NULL DEFAULT 0,
      services JSONB NOT NULL DEFAULT '[]'::jsonb,products JSONB NOT NULL DEFAULT '[]'::jsonb,note TEXT,saved_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS wz_shift_reports_date_idx ON wz_shift_reports(date);
    CREATE INDEX IF NOT EXISTS wz_shift_reports_employee_idx ON wz_shift_reports(employee_id);
    CREATE TABLE IF NOT EXISTS wz_push_subscriptions(
      id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES wz_users(id) ON DELETE CASCADE,
      endpoint TEXT UNIQUE NOT NULL,p256dh TEXT NOT NULL,auth TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS wz_push_subscriptions_user_idx ON wz_push_subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS wz_app_state(
      id INTEGER PRIMARY KEY CHECK (id=1),
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wz_user_profiles(
      user_id BIGINT PRIMARY KEY REFERENCES wz_users(id) ON DELETE CASCADE,
      phone TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wz_notifications(
      id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES wz_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,reference_id TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,
      read_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id,kind,reference_id)
    );
    CREATE INDEX IF NOT EXISTS wz_notifications_user_idx ON wz_notifications(user_id,created_at DESC);
  `);
  await p.query(`ALTER TABLE wz_shift_reports ADD COLUMN IF NOT EXISTS cash_expenses JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await p.query(`
    INSERT INTO wz_branches(id,name,active) VALUES
    ('B001','WZBARBERSHOP MASBAGIK',true),('B002','WZBARBERSHOP MONJOK',true),
    ('B003','WZBARBERSHOP GUNUNGSARI',true),('B004','WZBARBERSHOP KURANJI',true),
    ('B005','WZBARBERSHOP LEMBAR',true)
    ON CONFLICT (id) DO NOTHING;
  `);
  const employees=[
    ['E001','Rizky','B001'],['E002','ALVIN','B002'],['E003','KYONG','B003'],['E004','IWAN','B004'],['E005','DIKA','B005']
  ];
  for(const [id,name,branch] of employees){
    await p.query(`INSERT INTO wz_employees(id,name,role,branch_id,salary,active) VALUES($1,$2,'Barber',$3,2000000,true) ON CONFLICT(id) DO NOTHING`,[id,name,branch]);
    const username=defaultUsername(name), password=defaultPassword(name);
    await p.query(`INSERT INTO wz_users(username,password_hash,role,name,employee_id) VALUES($1,$2,'employee',$3,$4) ON CONFLICT(username) DO NOTHING`,[username,hashPassword(password),name,id]);
  }
  for(const [username,password,name,role] of [['owner','owner123','OWNER','owner'],['manager','manager123','MANAGER','manager']]){
    const exists=await p.query('SELECT id FROM wz_users WHERE username=$1',[username]);
    if(!exists.rowCount) await p.query('INSERT INTO wz_users(username,password_hash,role,name) VALUES($1,$2,$3,$4)',[username,hashPassword(password),role,name]);
  }
}

async function ensureSchema(){ if(!schemaPromise) schemaPromise=schema().catch(e=>{schemaPromise=null;throw e}); return schemaPromise; }

async function authUser(req){
  const cookie=String(req.headers.cookie||'');
  const m=cookie.match(/(?:^|;\s*)wz_session=([^;]+)/); if(!m)return null;
  const p=getPool();
  const r=await p.query(`SELECT u.id,u.username,u.role,u.name,u.employee_id,e.branch_id FROM wz_sessions s JOIN wz_users u ON u.id=s.user_id LEFT JOIN wz_employees e ON e.id=u.employee_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.active=true`,[tokenHash(decodeURIComponent(m[1]))]);
  return r.rows[0]||null;
}
function cookie(name,value,maxAge){return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`}
function send(res,status,data,headers={}){res.statusCode=status;for(const [k,v] of Object.entries(headers))res.setHeader(k,v);res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data));}
async function body(req){let s='';for await(const c of req)s+=c;if(!s)return {};try{return JSON.parse(s)}catch{const error=new Error('Request body JSON tidak valid.');error.statusCode=400;throw error}}
async function employeeFor(id){
  if(!id)return null;
  const r=await getPool().query('SELECT id,name,branch_id AS "branchId",active FROM wz_employees WHERE id=$1',[String(id)]);
  return r.rows[0]||null;
}
function validMoney(n){return Number.isFinite(Number(n))&&Number(n)>=0;}
function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(String(value||''));}
function validTransaction(t){
  const servicePrice=Number(t.servicePrice||0),discount=Number(t.discount||0),total=Number(t.total||0);
  return validDate(t.date)&&validMoney(servicePrice)&&validMoney(discount)&&validMoney(total)&&discount<=servicePrice&&Math.abs(total-Math.max(0,servicePrice-discount))<=0.001&&['SELESAI','VOID'].includes(String(t.status||'SELESAI'))&&['Tunai','QRIS','Transfer'].includes(String(t.payment||'Tunai'));
}
function validShift(r){
  const values=['openingCash','cash','qris','cashExpense','physicalCash','totalPayment','expectedCash','cashDifference','serviceTotal','productTotal','totalOmzet'];
  const services=Array.isArray(r.services)?r.services:[],products=Array.isArray(r.products)?r.products:[];
  const serviceTotal=Number(r.serviceTotal||0),productTotal=Number(r.productTotal||0),totalPayment=Number(r.totalPayment||0);
  const expected=Number(r.openingCash||0)+Number(r.cash||0)-Number(r.cashExpense||0);
  const serviceItems=services.filter(item=>Number(item?.qty||0)>0);
  const calculatedServiceTotal=services.reduce((sum,item)=>sum+(Number(item?.qty||0)*Number(item?.price||0)),0);
  const calculatedProductTotal=products.reduce((sum,item)=>sum+(Number(item?.qty||0)*Number(item?.price||0)),0);
  const itemValues=[...services,...products].every(item=>validMoney(item?.qty)&&validMoney(item?.price));
  return validDate(r.date)&&values.every(key=>validMoney(r[key]))&&itemValues&&serviceItems.length>0&&serviceTotal>0&&totalPayment>0&&
    Math.abs(totalPayment-(Number(r.cash||0)+Number(r.qris||0)))<=0.001&&
    Math.abs(serviceTotal-calculatedServiceTotal)<=0.001&&Math.abs(productTotal-calculatedProductTotal)<=0.001&&
    Math.abs(Number(r.totalOmzet||0)-(serviceTotal+productTotal))<=0.001&&
    Math.abs(Number(r.expectedCash||0)-expected)<=0.001&&
    Math.abs(Number(r.cashDifference||0)-(Number(r.physicalCash||0)-expected))<=0.001&&
    Math.abs(Number(r.cashDifference||0))<=0.001;
}


async function ownerAiData(u, branchId){
  if(!['owner','manager'].includes(String(u.role))) throw Object.assign(new Error('Hanya Owner/Manager yang dapat menggunakan WZ AI Analyst.'),{statusCode:403});
  const p=getPool();
  const [tx,sh,exp,emp,branches,state]=await Promise.all([
    p.query(`SELECT id,date,customer_name AS "customerName",service_name AS "serviceName",employee_id AS "employeeId",employee_name AS "employeeName",total,payment,status,discount FROM wz_transactions WHERE status='SELESAI' ORDER BY date,id`),
    p.query(`SELECT id,date,employee_id AS "employeeId",employee_name AS "employeeName",shift_type AS "shiftType",customers,cash,qris,cash_expense AS "cashExpense",total_payment AS "totalPayment",service_total AS "serviceTotal",product_total AS "productTotal",total_omzet AS "totalOmzet",services,products,cash_expenses AS "cashExpenses",note FROM wz_shift_reports ORDER BY date,id`),
    p.query(`SELECT id,date,branch_id AS "branchId",category,amount,note FROM wz_expenses ORDER BY date,id`).catch(()=>({rows:[]})),
    p.query(`SELECT id,name,role,branch_id AS "branchId",active,target,salary FROM wz_employees ORDER BY id`),
    p.query(`SELECT id,name,active FROM wz_branches ORDER BY id`),
    p.query(`SELECT data FROM wz_app_state WHERE id=1`).catch(()=>({rows:[]}))
  ]);
  const branchMap=new Map(branches.rows.map(b=>[String(b.id),b.name]));
  const empMap=new Map(emp.rows.map(e=>[String(e.id),e]));
  const allowed=(employeeId)=>!branchId||branchId==='ALL'||String(empMap.get(String(employeeId))?.branchId||'')===String(branchId);
  const transactions=tx.rows.filter(r=>allowed(r.employeeId)).map(r=>({...r,branchId:empMap.get(String(r.employeeId))?.branchId||null,branchName:branchMap.get(String(empMap.get(String(r.employeeId))?.branchId||''))||null}));
  const shifts=sh.rows.filter(r=>allowed(r.employeeId)).map(r=>({...r,branchId:empMap.get(String(r.employeeId))?.branchId||null,branchName:branchMap.get(String(empMap.get(String(r.employeeId))?.branchId||''))||null}));
  const expenses=exp.rows.filter(r=>!branchId||branchId==='ALL'||String(r.branchId||'')===String(branchId));
  const employees=emp.rows.filter(e=>!branchId||branchId==='ALL'||String(e.branchId||'')===String(branchId));
  const products=state.rows[0]?.data?.products||[];
  return {branchId:branchId||'ALL',branches:branches.rows,employees,transactions,shiftReports:shifts,expenses,products};
}
function aiCompactData(data){
  const tx=data.transactions,sh=data.shiftReports,ex=data.expenses;
  const omzetTx=tx.reduce((s,r)=>s+Number(r.total||0),0), omzetSh=sh.reduce((s,r)=>s+Number(r.totalOmzet||r.totalPayment||0),0);
  const expSh=sh.reduce((s,r)=>s+Number(r.cashExpense||0),0), expGeneral=ex.reduce((s,r)=>s+Number(r.amount||0),0);
  const customers=sh.reduce((s,r)=>s+Number(r.customers||0),0);
  const service={}; const product={}; const employee={}; const branch={};
  sh.forEach(r=>{const e=r.employeeName||r.employeeId||'-';employee[e]=(employee[e]||0)+Number(r.totalOmzet||r.totalPayment||0);const b=r.branchName||r.branchId||'-';branch[b]=(branch[b]||0)+Number(r.totalOmzet||r.totalPayment||0);(r.services||[]).forEach(i=>{const n=i.serviceName||i.name||i.serviceId||'-';service[n]=(service[n]||0)+Number(i.qty||0)});(r.products||[]).forEach(i=>{const n=i.name||i.productName||i.productId||'-';product[n]=(product[n]||0)+Number(i.qty||0)})});
  tx.forEach(r=>{const e=r.employeeName||r.employeeId||'-';employee[e]=(employee[e]||0)+Number(r.total||0);const b=r.branchName||r.branchId||'-';branch[b]=(branch[b]||0)+Number(r.total||0)});
  return {scope:data.branchId,summary:{transactions:tx.length,shiftReports:sh.length,customers,omzetPOS:omzetTx,omzetShift:omzetSh,pengeluaranShift:expSh,pengeluaranUmum:expGeneral,pengeluaranTotal:expSh+expGeneral},topKaryawan:Object.entries(employee).sort((a,b)=>b[1]-a[1]).slice(0,20),omzetPerCabang:Object.entries(branch).sort((a,b)=>b[1]-a[1]),layananTerjual:Object.entries(service).sort((a,b)=>b[1]-a[1]).slice(0,30),produkTerjual:Object.entries(product).sort((a,b)=>b[1]-a[1]).slice(0,30),pengeluaran:ex.slice(-100),shiftReports:sh.slice(-200),transactions:tx.slice(-200),employees:data.employees,products:data.products};
}

async function handler(req,res){
  try{
    await ensureSchema();
    const path=req.url.split('?')[0].replace(/^\/api\/?/,'').replace(/\/$/,'');
    if(path==='ready'){
      const missing=missingRequiredConfig();
      if(missing.length)return send(res,503,{ok:false,service:'WZ MANAGE PRO API',database:true,missingRequiredConfig:missing});
      return send(res,200,{ok:true,service:'WZ MANAGE PRO API',database:true,push:true,ai:localAiEnabled()||!!String(process.env.OPENAI_API_KEY||'').trim()});
    }
    if(path==='auth/login' && req.method==='POST'){
      const b=await body(req),username=String(b.username||'').trim(),password=String(b.password||'');
      if(!username||!password)return send(res,400,{ok:false,error:'Username dan password wajib diisi.'});
      const p=getPool(),r=await p.query('SELECT u.*,e.branch_id FROM wz_users u LEFT JOIN wz_employees e ON e.id=u.employee_id WHERE u.username=$1 AND u.active=true',[username]),u=r.rows[0];
      if(!u||!verifyPassword(password,u.password_hash))return send(res,401,{ok:false,error:'Username atau password salah.'});
      const t=token(); await p.query('DELETE FROM wz_sessions WHERE expires_at<=NOW()');
      await p.query('INSERT INTO wz_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL \'30 days\')',[tokenHash(t),u.id]);
      return send(res,200,{ok:true,user:{username:u.username,role:u.role,name:u.name,employeeId:u.employee_id||null,branchId:u.branch_id||null}}, {'Set-Cookie':cookie('wz_session',t,60*60*24*30)});
    }
    if(path==='auth/me' && req.method==='GET'){
      const u=await authUser(req); if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      return send(res,200,{ok:true,user:{username:u.username,role:u.role,name:u.name,employeeId:u.employee_id||null,branchId:u.branch_id||null}});
    }
    if(path==='auth/logout' && req.method==='POST'){
      const c=String(req.headers.cookie||''),m=c.match(/(?:^|;\s*)wz_session=([^;]+)/);if(m)await getPool().query('DELETE FROM wz_sessions WHERE token_hash=$1',[tokenHash(decodeURIComponent(m[1]))]);
      return send(res,200,{ok:true},{'Set-Cookie':cookie('wz_session','',0)});
    }
    if(path==='push/vapid-public-key' && req.method==='GET'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      if(!pushConfigured())return send(res,503,{ok:false,error:'Web Push belum dikonfigurasi di server.'});
      return send(res,200,{ok:true,publicKey:process.env.VAPID_PUBLIC_KEY});
    }
    if(path==='push/subscribe' && req.method==='POST'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      const b=await body(req),endpoint=String(b.endpoint||''),keys=b.keys||{},p256dh=String(keys.p256dh||''),auth=String(keys.auth||'');
      if(!endpoint||!p256dh||!auth)return send(res,400,{ok:false,error:'Subscription push tidak valid.'});
      await getPool().query('INSERT INTO wz_push_subscriptions(user_id,endpoint,p256dh,auth,updated_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,updated_at=NOW()',[u.id,endpoint,p256dh,auth]);
      return send(res,200,{ok:true});
    }
    if(path==='push/unsubscribe' && req.method==='POST'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      const b=await body(req);if(b.endpoint)await getPool().query('DELETE FROM wz_push_subscriptions WHERE user_id=$1 AND endpoint=$2',[u.id,String(b.endpoint)]);return send(res,200,{ok:true});
    }
    if(path==='ai-analyst' && req.method==='POST'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      if(u.role!=='owner')return send(res,403,{ok:false,error:'WZ AI Analyst hanya tersedia untuk Owner.'});
      const b=await body(req),question=String(b.question||'').trim(),branchId=String(b.branchId||'ALL');
      if(!question)return send(res,400,{ok:false,error:'Pertanyaan wajib diisi.'});
      const data=await ownerAiData(u,branchId),compact=aiCompactData(data);
      const apiKey=String(process.env.OPENAI_API_KEY||'').trim();
      if(!apiKey && !localAiEnabled())return send(res,503,{ok:false,error:'AI Engine belum dikonfigurasi. Isi OPENAI_API_KEY atau aktifkan AI lokal.'});
      if(!apiKey){
        const answer=localAiAnswer(question,compact);
        return send(res,200,{ok:true,answer,aiConfigured:true,scope:branchId,source:'WZ LOCAL AI'});
      }
      const system=`Kamu adalah WZ AI Analyst untuk Owner WZ MANAGE PRO. Jawab hanya berdasarkan DATA WZ yang diberikan. Jangan mengarang angka, transaksi, karyawan, cabang, layanan, produk, atau penyebab. Jika data tidak cukup, katakan data tidak cukup. Semua nominal dalam Rupiah. Bedakan POS dan TUTUP SHIFT sebagai sumber data, jangan menyatukan transaksi hanya karena namanya mirip. Cabang yang dipilih adalah scope analisis. Jika diminta perhitungan, hitung dari data. Jawab bahasa Indonesia, ringkas tetapi jelas, dan sebutkan periode/cabang bila diketahui.`;
      const payload={model:process.env.OPENAI_MODEL||'gpt-4o-mini',input:[{role:'system',content:[{type:'input_text',text:system}]},{role:'user',content:[{type:'input_text',text:`PERTANYAAN OWNER:\n${question}\n\nDATA WZ (JSON):\n${JSON.stringify(compact)}` }]}],temperature:0.1};
      const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const out=await r.json().catch(()=>({}));
      if(!r.ok)return send(res,502,{ok:false,error:'Penyedia AI gagal memproses pertanyaan.',detail:process.env.NODE_ENV==='production'?undefined:(out.error?.message||'')});
      const answer=out.output_text||out.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').filter(Boolean).join('\n')||'AI tidak menghasilkan jawaban.';
      return send(res,200,{ok:true,answer,aiConfigured:true,scope:branchId,source:'OPENAI'});
    }
    if(path==='business' && req.method==='GET'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      const p=getPool();
      const txSql='SELECT id,date,customer_id AS "customerId",customer_name AS "customerName",service_id AS "serviceId",service_name AS "serviceName",service_price AS "servicePrice",employee_id AS "employeeId",employee_name AS "employeeName",total,payment,status,discount,created_at AS "createdAt",updated_at AS "updatedAt" FROM wz_transactions '+(u.role==='employee'?'WHERE employee_id=$1 ':'')+'ORDER BY date,id';
      const shSql='SELECT id,date,employee_id AS "employeeId",employee_name AS "employeeName",shift_type AS "shiftType",customers,opening_cash AS "openingCash",cash,qris,cash_expense AS "cashExpense",physical_cash AS "physicalCash",total_payment AS "totalPayment",expected_cash AS "expectedCash",cash_difference AS "cashDifference",service_total AS "serviceTotal",product_total AS "productTotal",CASE WHEN total_omzet > 0 THEN total_omzet ELSE total_payment END AS "totalOmzet",services,products,cash_expenses AS "cashExpenses",note,saved_at AS "savedAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM wz_shift_reports '+(u.role==='employee'?'WHERE employee_id=$1 ':'')+'ORDER BY date,id';
      const params=u.role==='employee'?[u.employee_id]:[];
      const tx=await p.query(txSql,params);
      const sh=await p.query(shSql,params);
      const notes=await p.query('SELECT id,kind,reference_id AS "referenceId",title,message,read_at AS "readAt",created_at AS "createdAt" FROM wz_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[u.id]);
      return send(res,200,{ok:true,transactions:tx.rows,shiftReports:sh.rows,notifications:notes.rows});
    }
    if(path==='notifications/read' && req.method==='POST'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      const b=await body(req);
      if(b.all){await getPool().query('UPDATE wz_notifications SET read_at=COALESCE(read_at,NOW()) WHERE user_id=$1',[u.id]);return send(res,200,{ok:true});}
      if(!b.id)return send(res,400,{ok:false,error:'ID notifikasi wajib diisi.'});
      await getPool().query('UPDATE wz_notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND user_id=$2',[b.id,u.id]);return send(res,200,{ok:true});
    }
    if(path==='app-state' && req.method==='GET'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      const r=await getPool().query('SELECT data,updated_at AS "updatedAt" FROM wz_app_state WHERE id=1');
      let data=r.rowCount?r.rows[0].data:{};
      if(u.role==='employee'){
        data={customers:Array.isArray(data?.customers)?data.customers:[],services:Array.isArray(data?.services)?data.services:[],products:Array.isArray(data?.products)?data.products:[],branches:Array.isArray(data?.branches)?data.branches:[],notifications:Array.isArray(data?.notifications)?data.notifications:[]};
      }else if(!['owner','manager'].includes(u.role))return send(res,403,{ok:false,error:'Akses ditolak.'});
      return send(res,200,{ok:true,data,updatedAt:r.rowCount?r.rows[0].updatedAt:null});
    }
    if(path==='app-state' && req.method==='PUT'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      const b=await body(req);const data=b?.data;const expectedUpdatedAt=b?.expectedUpdatedAt||null;
      if(!data||typeof data!=='object'||Array.isArray(data))return send(res,400,{ok:false,error:'Data aplikasi tidak valid.'});
      if(u.role==='employee'){
        const customers=Array.isArray(data.customers)?data.customers:[];
        if(JSON.stringify(customers).length>4*1024*1024)return send(res,413,{ok:false,error:'Data pelanggan terlalu besar.'});
        const saved=await getPool().query(`INSERT INTO wz_app_state(id,data,updated_at) VALUES(1,jsonb_build_object('customers',$1::jsonb),NOW()) ON CONFLICT(id) DO UPDATE SET data=wz_app_state.data||jsonb_build_object('customers',$1::jsonb),updated_at=NOW() WHERE $2::timestamptz IS NULL OR wz_app_state.updated_at=$2::timestamptz RETURNING updated_at AS "updatedAt"`,[JSON.stringify(customers),expectedUpdatedAt]);
        if(!saved.rowCount&&expectedUpdatedAt)return send(res,409,{ok:false,error:'Data server sudah berubah. Muat ulang sebelum menyimpan.'});
        return send(res,200,{ok:true,updatedAt:saved.rows[0]?.updatedAt||null});
      }
      if(!['owner','manager'].includes(u.role))return send(res,403,{ok:false,error:'Hanya Owner/Manager yang dapat menyimpan data online.'});
      const payload=JSON.stringify(data);
      if(payload.length>8*1024*1024)return send(res,413,{ok:false,error:'Data aplikasi terlalu besar.'});
      const saved=await getPool().query(`INSERT INTO wz_app_state(id,data,updated_at) VALUES(1,$1::jsonb,NOW()) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW() WHERE $2::timestamptz IS NULL OR wz_app_state.updated_at=$2::timestamptz RETURNING updated_at AS "updatedAt"`,[payload,expectedUpdatedAt]);
      if(!saved.rowCount&&expectedUpdatedAt)return send(res,409,{ok:false,error:'Data server sudah berubah. Muat ulang sebelum menyimpan.'});
      return send(res,200,{ok:true,updatedAt:saved.rows[0]?.updatedAt||null});
    }
    if(path==='profile' && req.method==='GET'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      const r=await getPool().query('SELECT phone,avatar FROM wz_user_profiles WHERE user_id=$1',[u.id]);
      return send(res,200,{ok:true,user:{...u},profile:r.rowCount?r.rows[0]:{phone:'',avatar:''}});
    }
    if(path==='profile' && req.method==='PUT'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      const b=await body(req),phone=String(b.phone||'').trim(),avatar=String(b.avatar||'');
      if(avatar.length>3*1024*1024)return send(res,413,{ok:false,error:'Foto profil terlalu besar.'});
      const name=u.role==='employee'?u.name:String(b.name||u.name).trim();
      if(!name)return send(res,400,{ok:false,error:'Nama wajib diisi.'});
      await getPool().query('UPDATE wz_users SET name=$1,updated_at=NOW() WHERE id=$2',[name,u.id]);
      await getPool().query(`INSERT INTO wz_user_profiles(user_id,phone,avatar,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(user_id) DO UPDATE SET phone=EXCLUDED.phone,avatar=EXCLUDED.avatar,updated_at=NOW()`,[u.id,phone,avatar]);
      const er=await getPool().query('SELECT id,username,role,name,employee_id AS "employeeId",(SELECT branch_id FROM wz_employees WHERE id=wz_users.employee_id) AS "branchId" FROM wz_users WHERE id=$1',[u.id]);
      return send(res,200,{ok:true,user:er.rows[0],profile:{phone,avatar}});
    }
    if(path==='password' && req.method==='POST'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      const b=await body(req),oldPassword=String(b.oldPassword||''),newPassword=String(b.newPassword||'');
      if(newPassword.length<4)return send(res,400,{ok:false,error:'Password baru minimal 4 karakter.'});
      const r=await getPool().query('SELECT password_hash FROM wz_users WHERE id=$1 AND active=true',[u.id]);
      if(!r.rowCount||!verifyPassword(oldPassword,r.rows[0].password_hash))return send(res,400,{ok:false,error:'Password lama salah.'});
      await getPool().query('UPDATE wz_users SET password_hash=$1,updated_at=NOW() WHERE id=$2',[hashPassword(newPassword),u.id]);
      return send(res,200,{ok:true});
    }

    if(path==='reset-business' && req.method==='POST'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      if(!['owner','manager'].includes(u.role))return send(res,403,{ok:false,error:'Hanya Owner/Manager yang dapat mereset data bisnis.'});
      const client=await getPool().connect();
      try{
        await client.query('BEGIN');
        const tx=await client.query('DELETE FROM wz_transactions RETURNING id');
        const shifts=await client.query('DELETE FROM wz_shift_reports RETURNING id');
        await client.query('COMMIT');
        return send(res,200,{ok:true,transactions:tx.rowCount,shiftReports:shifts.rowCount,total:tx.rowCount+shifts.rowCount});
      }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
    }
    if(path==='sync-business' && req.method==='POST'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      const b=await body(req),txs=Array.isArray(b.transactions)?b.transactions:[],shifts=Array.isArray(b.shiftReports)?b.shiftReports:[];
      if(u.role==='employee'){
        if(!u.employee_id)return send(res,403,{ok:false,error:'Akun karyawan tidak terhubung ke ID karyawan.'});
        if(txs.some(t=>String(t.employeeId)!==String(u.employee_id)))return send(res,403,{ok:false,error:'Karyawan hanya boleh sinkronkan transaksi miliknya.'});
        if(shifts.some(r=>String(r.employeeId)!==String(u.employee_id)))return send(res,403,{ok:false,error:'Karyawan hanya boleh sinkronkan laporan shift miliknya.'});
      }
      if(txs.some(t=>!t.id||!t.employeeId||!validTransaction(t)))return send(res,400,{ok:false,error:'Data transaksi tidak valid.'});
      if(shifts.some(r=>!r.id||!r.employeeId||!validShift(r)))return send(res,400,{ok:false,error:'Data laporan shift tidak valid.'});
      const employeeIds=[...new Set([...txs.map(t=>t.employeeId),...shifts.map(r=>r.employeeId)].filter(Boolean).map(String))];
      if(employeeIds.length){
        const er=await getPool().query('SELECT id,active FROM wz_employees WHERE id = ANY($1::text[])',[employeeIds]);
        const valid=new Map(er.rows.map(x=>[String(x.id),x]));
        for(const id of employeeIds){if(!valid.has(id))return send(res,400,{ok:false,error:'ID karyawan tidak terdaftar: '+id});}
        if(txs.some(t=>t.employeeId&&valid.get(String(t.employeeId))?.active===false)||shifts.some(r=>r.employeeId&&valid.get(String(r.employeeId))?.active===false))return send(res,400,{ok:false,error:'Karyawan nonaktif tidak dapat menyimpan data baru.'});
      }
      const client=await getPool().connect();
      try{
        await client.query('BEGIN');
        for(const t of txs){
          await client.query(`INSERT INTO wz_transactions(id,date,customer_id,customer_name,service_id,service_name,service_price,employee_id,employee_name,total,payment,status,discount,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) ON CONFLICT(id) DO UPDATE SET date=EXCLUDED.date,customer_id=EXCLUDED.customer_id,customer_name=EXCLUDED.customer_name,service_id=EXCLUDED.service_id,service_name=EXCLUDED.service_name,service_price=EXCLUDED.service_price,employee_id=EXCLUDED.employee_id,employee_name=EXCLUDED.employee_name,total=EXCLUDED.total,payment=EXCLUDED.payment,status=EXCLUDED.status,discount=EXCLUDED.discount,updated_at=NOW()`,[t.id,t.date,t.customerId||null,t.customerName||null,t.serviceId||null,t.serviceName||null,Number(t.servicePrice||0),t.employeeId||null,t.employeeName||null,Number(t.total||0),t.payment||'Tunai',t.status||'SELESAI',Number(t.discount||0)]);
        }
        for(const r of shifts){
          await client.query(`INSERT INTO wz_shift_reports(id,date,employee_id,employee_name,shift_type,customers,opening_cash,cash,qris,cash_expense,physical_cash,total_payment,expected_cash,cash_difference,service_total,product_total,total_omzet,services,products,cash_expenses,note,saved_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22,NOW()) ON CONFLICT(id) DO UPDATE SET date=EXCLUDED.date,employee_id=EXCLUDED.employee_id,employee_name=EXCLUDED.employee_name,shift_type=EXCLUDED.shift_type,customers=EXCLUDED.customers,opening_cash=EXCLUDED.opening_cash,cash=EXCLUDED.cash,qris=EXCLUDED.qris,cash_expense=EXCLUDED.cash_expense,physical_cash=EXCLUDED.physical_cash,total_payment=EXCLUDED.total_payment,expected_cash=EXCLUDED.expected_cash,cash_difference=EXCLUDED.cash_difference,service_total=EXCLUDED.service_total,product_total=EXCLUDED.product_total,total_omzet=EXCLUDED.total_omzet,services=EXCLUDED.services,products=EXCLUDED.products,cash_expenses=EXCLUDED.cash_expenses,note=EXCLUDED.note,saved_at=EXCLUDED.saved_at,updated_at=NOW()`,[r.id,r.date,r.employeeId||null,r.employeeName||null,r.shiftType||null,Number(r.customers||0),Number(r.openingCash||0),Number(r.cash||0),Number(r.qris||0),Number(r.cashExpense||0),Number(r.physicalCash||0),Number(r.totalPayment||0),Number(r.expectedCash||0),Number(r.cashDifference||0),Number(r.serviceTotal||0),Number(r.productTotal||0),Number(r.totalOmzet||0),JSON.stringify(r.services||[]),JSON.stringify(r.products||[]),JSON.stringify(r.cashExpenses||[]),r.note||null,r.savedAt||null]);
          await createShiftNotifications(client,r,u.id).catch(()=>{});
        }
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
      await Promise.all(shifts.map(shift=>sendShiftPushes(shift,u.id).catch(()=>{})));
      return send(res,200,{ok:true,transactions:txs.length,shiftReports:shifts.length});
    }
    if(path==='transaction' && req.method==='POST'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});
      const t=await body(req);if(!t.id||!t.date||!t.employeeId)return send(res,400,{ok:false,error:'Data transaksi tidak lengkap.'});
      if(!validTransaction(t))return send(res,400,{ok:false,error:'Nilai transaksi tidak valid.'});
      if(u.role==='employee'&&String(t.employeeId)!==String(u.employee_id))return send(res,403,{ok:false,error:'Karyawan hanya boleh membuat transaksi atas namanya sendiri.'});
      const te=await employeeFor(t.employeeId);if(!te)return send(res,400,{ok:false,error:'Karyawan tidak terdaftar.'});
      if(te.active===false)return send(res,400,{ok:false,error:'Karyawan sudah nonaktif.'});
      const servicePrice=Number(t.servicePrice||0),discount=Number(t.discount||0),total=Number(t.total||0);
      const c=await getPool().connect();try{await c.query('BEGIN');await c.query(`INSERT INTO wz_transactions(id,date,customer_id,customer_name,service_id,service_name,service_price,employee_id,employee_name,total,payment,status,discount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,total=EXCLUDED.total,updated_at=NOW()`,[t.id,t.date,t.customerId||null,t.customerName||null,t.serviceId||null,t.serviceName||null,servicePrice,t.employeeId,te.name,total,t.payment||'Tunai',t.status||'SELESAI',discount]);await c.query('COMMIT');return send(res,200,{ok:true,id:t.id});}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
    }
    if(path==='transaction/void' && req.method==='POST'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});const b=await body(req);const r=await getPool().query("UPDATE wz_transactions SET status='VOID',updated_at=NOW() WHERE id=$1 AND ($2<>'employee' OR employee_id=$3) RETURNING id",[b.id,u.role,u.employee_id]);if(!r.rowCount)return send(res,404,{ok:false,error:'Transaksi tidak ditemukan atau tidak boleh diubah.'});return send(res,200,{ok:true});
    }
    if(path==='shift-report' && req.method==='POST'){
      const u=await authUser(req);if(!u)return send(res,401,{ok:false,error:'Belum login.'});const r=await body(req);if(!r.id||!r.date||!r.employeeId)return send(res,400,{ok:false,error:'Data shift tidak lengkap.'});
      if(Number(r.serviceTotal||0)<=0)return send(res,400,{ok:false,error:'Laporan shift wajib memiliki minimal 1 layanan.'});
      if(Number(r.totalPayment||0)<=0)return send(res,400,{ok:false,error:'Total pembayaran laporan shift harus lebih dari Rp0.'});if(!validShift(r))return send(res,400,{ok:false,error:'Nilai laporan shift tidak konsisten.'});if(u.role==='employee'&&String(r.employeeId)!==String(u.employee_id))return send(res,403,{ok:false,error:'Karyawan hanya boleh menyimpan shift miliknya.'});const re=await employeeFor(r.employeeId);if(!re)return send(res,400,{ok:false,error:'Karyawan tidak terdaftar.'});if(re.active===false)return send(res,400,{ok:false,error:'Karyawan sudah nonaktif.'});
      await getPool().query(`INSERT INTO wz_shift_reports(id,date,employee_id,employee_name,shift_type,customers,opening_cash,cash,qris,cash_expense,physical_cash,total_payment,expected_cash,cash_difference,service_total,product_total,total_omzet,services,products,cash_expenses,note,saved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22) ON CONFLICT(id) DO UPDATE SET customers=EXCLUDED.customers,opening_cash=EXCLUDED.opening_cash,cash=EXCLUDED.cash,qris=EXCLUDED.qris,cash_expense=EXCLUDED.cash_expense,physical_cash=EXCLUDED.physical_cash,total_payment=EXCLUDED.total_payment,expected_cash=EXCLUDED.expected_cash,cash_difference=EXCLUDED.cash_difference,service_total=EXCLUDED.service_total,product_total=EXCLUDED.product_total,total_omzet=EXCLUDED.total_omzet,services=EXCLUDED.services,products=EXCLUDED.products,cash_expenses=EXCLUDED.cash_expenses,note=EXCLUDED.note,saved_at=EXCLUDED.saved_at,updated_at=NOW()`,[r.id,r.date,r.employeeId,r.employeeName||u.name,r.shiftType||null,Number(r.customers||0),Number(r.openingCash||0),Number(r.cash||0),Number(r.qris||0),Number(r.cashExpense||0),Number(r.physicalCash||0),Number(r.totalPayment||0),Number(r.expectedCash||0),Number(r.cashDifference||0),Number(r.serviceTotal||0),Number(r.productTotal||0),Number(r.totalOmzet||0),JSON.stringify(r.services||[]),JSON.stringify(r.products||[]),JSON.stringify(r.cashExpenses||[]),r.note||null,r.savedAt||new Date().toISOString()]);
      await createShiftNotifications(getPool(),r,u.id).catch(()=>{});
      await sendShiftPushes(r,u.id).catch(()=>{});
      return send(res,200,{ok:true,id:r.id});
    }
    if(path==='employees' && req.method==='GET'){
      const u=await authUser(req);if(!u||!['owner','manager'].includes(u.role))return send(res,403,{ok:false,error:'Akses ditolak.'});
      const r=await getPool().query(`SELECT e.id,e.name,e.role,e.branch_id AS "branchId",e.salary,e.commission,e.target,e.attendance,e.eval,e.active FROM wz_employees e ORDER BY e.id`);
      return send(res,200,{ok:true,employees:r.rows});
    }
    if(path==='employees' && (req.method==='POST'||req.method==='PUT')){
      const u=await authUser(req);if(!u||!['owner','manager'].includes(u.role))return send(res,403,{ok:false,error:'Hanya Owner/Manager yang dapat mengelola karyawan.'});
      const b=await body(req);const p=getPool();
      const name=String(b.name||'').trim(),branchId=String(b.branchId||'').trim(),password=String(b.password||'').trim();
      if(!name)return send(res,400,{ok:false,error:'Nama karyawan wajib diisi.'});
      if(!branchId)return send(res,400,{ok:false,error:'Cabang wajib dipilih.'});
      if(!password)return send(res,400,{ok:false,error:'Password login wajib diisi.'});
      const id=String(b.id||'').trim() || `E${String((await p.query("SELECT COALESCE(MAX(CAST(SUBSTRING(id,2) AS INTEGER)),0)+1 n FROM wz_employees WHERE id LIKE 'E%'")).rows[0].n).padStart(3,'0')}`;
      const role=String(b.role||'Barber'),salary=Number(b.salary)||0,target=Number(b.target)||0,username=String(b.username||defaultUsername(name)).trim();
      const client=await p.connect();
      try{
        await client.query('BEGIN');
        await client.query(`INSERT INTO wz_employees(id,name,role,branch_id,salary,commission,target,active,updated_at) VALUES($1,$2,$3,$4,$5,0,$6,true,NOW()) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,role=EXCLUDED.role,branch_id=EXCLUDED.branch_id,salary=EXCLUDED.salary,target=EXCLUDED.target,updated_at=NOW()`,[id,name,role,branchId,salary,target]);
        const existing=await client.query('SELECT id FROM wz_users WHERE employee_id=$1',[id]);
        const ph=hashPassword(password);
        if(existing.rowCount) await client.query('UPDATE wz_users SET username=$1,password_hash=$2,name=$3,role=\'employee\',active=true,updated_at=NOW() WHERE employee_id=$4',[username,ph,name,id]);
        else await client.query('INSERT INTO wz_users(username,password_hash,role,name,employee_id) VALUES($1,$2,\'employee\',$3,$4)',[username,ph,name,id]);
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
      const r=await p.query(`SELECT id,name,role,branch_id AS "branchId",salary,commission,target,attendance,eval,active FROM wz_employees WHERE id=$1`,[id]);
      return send(res,200,{ok:true,employee:r.rows[0],username});
    }
    if(path==='employees' && req.method==='DELETE'){
      const u=await authUser(req);if(!u||!['owner','manager'].includes(u.role))return send(res,403,{ok:false,error:'Akses ditolak.'});
      const id=new URL(req.url,'http://localhost').searchParams.get('id');if(!id)return send(res,400,{ok:false,error:'ID karyawan wajib diisi.'});
      const client=await getPool().connect();try{await client.query('BEGIN');await client.query('DELETE FROM wz_users WHERE employee_id=$1',[id]);const r=await client.query('DELETE FROM wz_employees WHERE id=$1 RETURNING id',[id]);if(!r.rowCount){await client.query('ROLLBACK');return send(res,404,{ok:false,error:'Karyawan tidak ditemukan.'});}await client.query('COMMIT');return send(res,200,{ok:true});}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()};
    }
    return send(res,404,{ok:false,error:'Endpoint tidak ditemukan.'});
  }catch(e){console.error(e);return send(res,e.statusCode||500,{ok:false,error:safeServerError(e)});}
}
module.exports=handler;
