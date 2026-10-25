/* SailLab — local data storage, no server upload. GPS access depends on browser permissions and limitations. */
const $ = id => document.getElementById(id);
const DB_NAME='SailLabDB', DB_VERSION=1, STORE='sessions';
let db, watchId=null, current=null, timerId=null, lastFix=null, lastSampleAt=null, sessionStartMs=null, elapsedBeforePause=0, paused=false, samples=[], events=[], tackSegments={port:[],starboard:[]}, activeTack=null, toastTimer, motion={heel:null,pitch:null,enabled:false};
let zeroOffsets=JSON.parse(localStorage.getItem('saillabZeroOffsets')||'{"heel":0,"pitch":0}');
let widgetPrefs=JSON.parse(localStorage.getItem('saillabWidgetPrefs')||'{}');
let wakeLock=null, locked=false, unlockTaps=0, unlockTapTimer=null;
const KNOTS_PER_MS=1.943844;
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2600)}
function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>req.result.createObjectStore(STORE,{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
function dbAll(){return new Promise((resolve,reject)=>{const r=db.transaction(STORE).objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error)})}
function dbPut(obj){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(obj);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}
function dbDelete(id){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}
function uid(){return crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random().toString(16).slice(2)}
function fmtTime(ms){const s=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`}
function elapsed(){return elapsedBeforePause+(sessionStartMs&&!paused?Date.now()-sessionStartMs:0)}
function currentMeta(){return {name:$('sessionName').value.trim()||'Sailing session',boat:$('boat').value.trim(),boatClass:$('boatClass').value.trim(),crew:$('crew').value.trim(),location:$('location').value.trim(),wind:$('wind').value===''?null:Number($('wind').value),setup:$('setup').value,notes:$('notes').value}}

function correctedMotion(channel){
  return motion[channel]==null ? null : motion[channel] - (Number(zeroOffsets[channel]) || 0);
}
function updateMotionDisplay(){
  const heel=correctedMotion('heel'), pitch=correctedMotion('pitch');
  $('heel').innerHTML = heel==null ? '—<small>°</small>' : `${heel.toFixed(1)}<small>°</small>`;
  $('pitch').innerHTML = pitch==null ? '—<small>°</small>' : `${pitch.toFixed(1)}<small>°</small>`;
  $('zeroStatus').textContent=`Zero offsets — HEEL: ${(Number(zeroOffsets.heel)||0).toFixed(1)}°, PITCH: ${(Number(zeroOffsets.pitch)||0).toFixed(1)}°.`;
}
function onOrientation(e){
  // DeviceOrientationEvent angles describe the phone, not the boat; secure mounting/alignment is required.
  if(Number.isFinite(e.gamma)) motion.heel=e.gamma;
  if(Number.isFinite(e.beta)) motion.pitch=e.beta;
  motion.enabled=true;
  updateMotionDisplay();
}
async function enableMotion(){
  try{
    if(!('DeviceOrientationEvent' in window)){toast('Motion sensors are not supported by this browser');return}
    if(typeof DeviceOrientationEvent.requestPermission==='function'){
      const permission=await DeviceOrientationEvent.requestPermission();
      if(permission!=='granted'){toast('Motion sensor permission was not granted');return}
    }
    window.addEventListener('deviceorientation',onOrientation,true);
    toast('Motion sensors enabled. Mount and align the phone with the boat.');
  }catch(e){toast('Could not enable motion sensors: '+e.message)}
}


function setZero(channel){
  if(motion[channel]==null){toast(`No ${channel.toUpperCase()} reading yet. Enable motion sensors first.`);return}
  zeroOffsets[channel]=motion[channel];
  localStorage.setItem('saillabZeroOffsets',JSON.stringify(zeroOffsets));
  updateMotionDisplay();
  toast(`${channel.toUpperCase()} zero set. Keep the boat/phone in the reference position.`);
}
function applyWidgetPrefs(){
  const grid=document.querySelector('#view-live .metric-grid');
  if(!grid)return;
  const cards=[...document.querySelectorAll('#view-live [data-widget]')];
  cards.forEach(card=>{
    const id=card.dataset.widget, p=widgetPrefs[id]||{};
    card.classList.toggle('widget-full',p.width==='full');
    card.classList.toggle('widget-hidden',p.hidden===true);
    ['small','medium','large','xlarge'].forEach(k=>card.classList.toggle('widget-font-'+k,(p.font||'medium')===k));
    card.style.background=p.bg||'';
    card.style.color=p.color||'';
    card.style.setProperty('--widget-text',p.color||'');
    if(p.order!==undefined){
      const parent=card.parentElement;
      if(parent)parent.appendChild(card);
    }
  });
  cards.sort((a,b)=>(widgetPrefs[a.dataset.widget]?.order??100)-(widgetPrefs[b.dataset.widget]?.order??100)).forEach(card=>card.parentElement?.appendChild(card));
  loadWidgetForm();
}
function loadWidgetForm(){
  const id=$('widgetSelect')?.value;if(!id)return;
  const p=widgetPrefs[id]||{};
  $('widgetWidth').value=p.width||'half';
  $('widgetFont').value=p.font||'medium';
  $('widgetBg').value=p.bg||'#101f2e';
  $('widgetColor').value=p.color||'#f1f6fa';
  $('widgetHide').textContent=p.hidden?'Show widget':'Hide widget';
}
function saveSelectedWidget(){
  const id=$('widgetSelect').value;
  widgetPrefs[id]={...(widgetPrefs[id]||{}),width:$('widgetWidth').value,font:$('widgetFont').value,bg:$('widgetBg').value,color:$('widgetColor').value};
  localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));
  applyWidgetPrefs();
}
function moveWidget(direction){
  const cards=[...document.querySelectorAll('#view-live [data-widget]')];
  const ids=cards.map(c=>c.dataset.widget);
  const id=$('widgetSelect').value;
  const ordered=ids.sort((a,b)=>(widgetPrefs[a]?.order??100)-(widgetPrefs[b]?.order??100));
  const i=ordered.indexOf(id), j=i+direction;
  if(j<0||j>=ordered.length)return;
  [ordered[i],ordered[j]]=[ordered[j],ordered[i]];
  ordered.forEach((key,index)=>widgetPrefs[key]={...(widgetPrefs[key]||{}),order:index});
  localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));
  applyWidgetPrefs();
}
async function requestWakeLock(){
  try{
    if(!('wakeLock' in navigator)){toast('Screen Wake Lock is not supported by this browser');return}
    wakeLock=await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release',()=>{wakeLock=null});
    $('wakeLockBtn').textContent='Release screen wake lock';
    toast('Screen will stay awake while supported.');
  }catch(e){toast('Could not keep screen awake: '+e.message)}
}
async function toggleWakeLock(){
  if(wakeLock){await wakeLock.release();wakeLock=null;$('wakeLockBtn').textContent='Keep screen awake';toast('Screen wake lock released')}
  else await requestWakeLock();
}
function lockScreen(){
  locked=true;unlockTaps=0;
  $('screenLockOverlay').classList.add('active');
  $('screenLockOverlay').setAttribute('aria-hidden','false');
  document.body.classList.add('app-locked');
  $('tapProgress').textContent='0 / 3 taps';
  requestWakeLock();
}
function unlockScreen(){
  locked=false;unlockTaps=0;
  $('screenLockOverlay').classList.remove('active');
  $('screenLockOverlay').setAttribute('aria-hidden','true');
  document.body.classList.remove('app-locked');
  clearTimeout(unlockTapTimer);
}
function handleUnlockTap(){
  if(!locked)return;
  unlockTaps++;
  $('tapProgress').textContent=`${Math.min(unlockTaps,3)} / 3 taps`;
  clearTimeout(unlockTapTimer);
  if(unlockTaps>=3){unlockScreen();toast('Screen unlocked')}
  else unlockTapTimer=setTimeout(()=>{unlockTaps=0;$('tapProgress').textContent='0 / 3 taps'},1800);
}
function resetWidgetPrefs(){
  widgetPrefs={};localStorage.removeItem('saillabWidgetPrefs');applyWidgetPrefs();toast('Widget layout reset');
}

function createSession(){return {id:uid(),createdAt:new Date().toISOString(),...currentMeta(),status:'recording',startedAt:new Date().toISOString(),durationMs:0,samples:[],events:[],gpx:false}}
async function saveCurrent(){if(!current)return;current={...current,...currentMeta(),samples:[...samples],events:[...events],durationMs:elapsed(),status:paused?'paused':'recording',updatedAt:new Date().toISOString()};await dbPut(current)}
async function start(){if(current&&current.status==='recording'){toast('Session already running');return}if(!navigator.geolocation){toast('Geolocation is not supported');return}if(!window.isSecureContext){toast('GPS requires HTTPS. Publish the app over HTTPS.');return}
 if(!current||['finished','imported'].includes(current.status)){current=createSession();samples=[];events=[];elapsedBeforePause=0;sessionStartMs=Date.now();paused=false}
 else{sessionStartMs=Date.now();paused=false}
 updateControls();requestGps();timerId=setInterval(()=>{if(current&&!paused){$('duration').textContent=fmtTime(elapsed());saveCurrent().catch(console.error)}},5000);toast('Recording started')}
function requestGps(){if(watchId!==null)return;let fixCount=0;watchId=navigator.geolocation.watchPosition(pos=>{fixCount++;lastFix=pos;const c=pos.coords;const speed=c.speed==null?null:Math.max(0,c.speed*KNOTS_PER_MS);const sample={t:pos.timestamp||Date.now(),lat:c.latitude,lon:c.longitude,alt:c.altitude==null?null:c.altitude,accuracy:c.accuracy==null?null:c.accuracy,sog:speed,course:c.heading==null?null:c.heading,heel:correctedMotion('heel'),pitch:correctedMotion('pitch')};if(current&&!paused){samples.push(sample);current.samples=samples;if(samples.length>100000){samples.shift()}if(lastSampleAt){const dt=(sample.t-lastSampleAt)/1000;if(dt>0)$('sampleRate').textContent=(1/dt).toFixed(1)+' Hz effettivi'}lastSampleAt=sample.t;updateStats();if(activeTack){const prev=activeTack.last;if(prev&&sample.course!=null)activeTack.courseSamples.push(sample.course);activeTack.last=sample;activeTack.distance+=prev?distanceNm(prev,sample):0;activeTack.samples.push(sample)}}
 $('gpsBadge').className='status ok';$('gpsBadge').innerHTML='<span class="dot"></span> GPS active';$('sog').textContent=speed==null?'—':speed.toFixed(1);$('course').innerHTML=(sample.course==null?'—':Math.round(sample.course))+'<small>°</small>';$('accuracy').innerHTML=(sample.accuracy==null?'—':Math.round(sample.accuracy))+'<small> m</small>';$('coords').textContent=`${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`;$('samples').textContent=samples.length;if(typeof updateRaceMetrics==='function')updateRaceMetrics();if(typeof renderCockpit==='function')renderCockpit();},err=>{$('gpsBadge').className='status bad';$('gpsBadge').innerHTML='<span class="dot"></span> GPS unavailable';toast(({1:'GPS permission denied. Check your browser settings.',2:'GPS signal unavailable.',3:'GPS timed out. Try again outdoors.'})[err.code]||'GPS error');if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}}, {enableHighAccuracy:true,maximumAge:1000,timeout:15000})}
function stopGps(){if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}}
function updateControls(){const active=!!current&&current.status==='recording';$('startBtn').disabled=active;$('pauseBtn').disabled=!active;$('resumeBtn').disabled=!(current&&paused);$('stopBtn').disabled=!current||!['recording','paused'].includes(current.status)}
async function pause(){if(!current||paused)return;elapsedBeforePause=elapsed();paused=true;sessionStartMs=null;await saveCurrent();updateControls();toast('Session paused')}
async function resume(){if(!current||!paused)return;sessionStartMs=Date.now();paused=false;await saveCurrent();updateControls();requestGps();toast('Recording resumed')}
async function finish(){if(!current)return;current.durationMs=elapsed();current.status='finished';current.finishedAt=new Date().toISOString();current={...current,...currentMeta(),samples:[...samples],events:[...events]};await dbPut(current);stopGps();clearInterval(timerId);timerId=null;sessionStartMs=null;paused=false;updateControls();renderSessions();renderAnalysis();toast('Session saved on this device')}
function updateStats(){const valid=samples.map(s=>s.sog).filter(Number.isFinite);$('avgSpeed').textContent=valid.length?(valid.reduce((a,b)=>a+b,0)/valid.length).toFixed(1):'—';$('maxSpeed').textContent=valid.length?Math.max(...valid).toFixed(1):'—';$('samples').textContent=samples.length}
function eventRecord(type,note=''){if(!current){toast('Start a session before logging events');return}const e={id:uid(),type,note,timestamp:new Date().toISOString(),elapsedMs:elapsed(),lat:lastFix?.coords.latitude??null,lon:lastFix?.coords.longitude??null};events.push(e);saveCurrent().catch(console.error);toast(`${type} logged`)}
function distanceNm(a,b){const rad=x=>x*Math.PI/180;const R=6371000;const dLat=rad(b.lat-a.lat),dLon=rad(b.lon-a.lon),x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(x))/1852}
function stats(){const a=samples.map(s=>s.sog).filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return {n:0,mean:null,std:null,median:null};const mean=a.reduce((x,y)=>x+y,0)/a.length;return {n:a.length,mean,std:Math.sqrt(a.reduce((sum,x)=>sum+(x-mean)**2,0)/a.length),median:a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2,min:a[0],max:a[a.length-1]}}
function renderAnalysis(){const has=samples.length>0;$('analysisEmpty').hidden=has;$('analysisContent').hidden=!has;if(!has)return;const s=stats();$('aCount').textContent=s.n;$('aMean').innerHTML=s.mean==null?'—':s.mean.toFixed(2)+'<small> kn</small>';$('aStd').innerHTML=s.std==null?'—':s.std.toFixed(2)+'<small> kn</small>';let d=0;for(let i=1;i<samples.length;i++)d+=distanceNm(samples[i-1],samples[i]);$('distance').innerHTML=d.toFixed(2)+'<small> nm</small>';const body=$('sampleRows');body.innerHTML='';samples.slice(-30).reverse().forEach(x=>{const tr=document.createElement('tr');[new Date(x.t).toLocaleTimeString('it-IT'),x.sog==null?'—':x.sog.toFixed(2),x.course==null?'—':Math.round(x.course)+'°',x.accuracy==null?'—':Math.round(x.accuracy)].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.appendChild(td)});body.appendChild(tr)});drawChart()}
function drawChart(){const c=$('speedChart');if(!c||!samples.length)return;const rect=c.getBoundingClientRect(),ratio=window.devicePixelRatio||1;c.width=Math.max(300,rect.width*ratio);c.height=180*ratio;const ctx=c.getContext('2d');ctx.scale(ratio,ratio);const w=c.width/ratio,h=180;ctx.clearRect(0,0,w,h);const vals=samples.map(s=>s.sog).filter(Number.isFinite);if(!vals.length){ctx.fillStyle='#9eb0c0';ctx.fillText('No valid speed samples',12,30);return}const max=Math.max(1,...vals)*1.1;ctx.strokeStyle='#294054';ctx.lineWidth=1;for(let i=0;i<4;i++){const y=12+(h-28)*i/3;ctx.beginPath();ctx.moveTo(34,y);ctx.lineTo(w-8,y);ctx.stroke();ctx.fillStyle='#9eb0c0';ctx.font='10px sans-serif';ctx.fillText((max*(1-i/3)).toFixed(1),3,y+3)}ctx.strokeStyle='#54e0c0';ctx.lineWidth=2;ctx.beginPath();let n=0;const step=Math.max(1,Math.ceil(samples.length/(w-42)));for(let i=0;i<samples.length;i+=step){const v=samples[i].sog;if(!Number.isFinite(v))continue;const x=34+(w-44)*(i/Math.max(1,samples.length-1)),y=h-16-(h-32)*(v/max);if(!n++)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.stroke()}
async function renderSessions(){const all=(await dbAll()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));const list=$('sessionsList');list.innerHTML='';if(!all.length){list.innerHTML='<p class="muted">No saved sessions yet.</p>';return}for(const s of all){const row=document.createElement('div');row.className='session-row';const info=document.createElement('div');const title=document.createElement('div');title.className='session-title';title.textContent=s.name||'Unnamed session';const meta=document.createElement('div');meta.className='session-meta';meta.textContent=`${new Date(s.createdAt).toLocaleString('en-GB')} · ${(s.samples||[]).length} samples · ${s.status==='finished'?'finished':s.status==='imported'?'GPX imported':'incomplete'}`;info.append(title,meta);const actions=document.createElement('div');actions.className='session-actions';const load=document.createElement('button');load.textContent='Open';load.onclick=()=>loadSession(s.id);const exp=document.createElement('button');exp.textContent='JSON';exp.onclick=()=>downloadJson(s);const del=document.createElement('button');del.textContent='Delete';del.onclick=async()=>{if(confirm('Delete this session from this device?')){await dbDelete(s.id);if(current?.id===s.id){current=null;samples=[];events=[];updateControls()}renderSessions();toast('Session deleted')}};actions.append(load,exp,del);row.append(info,actions);list.append(row)}}
async function loadSession(id){const s=(await dbAll()).find(x=>x.id===id);if(!s)return;if(current&&['recording','paused'].includes(current.status)&&!confirm('Load another session? The active session will remain in the history.'))return;current=s;samples=[...(s.samples||[])];events=[...(s.events||[])];elapsedBeforePause=s.durationMs||0;sessionStartMs=null;paused=false;for(const [key,id2] of [['name','sessionName'],['boat','boat'],['boatClass','boatClass'],['crew','crew'],['location','location'],['wind','wind'],['setup','setup'],['notes','notes']])$(id2).value=s[key]??'';updateControls();updateStats();renderAnalysis();showView('analysis');toast('Session loaded')}
function download(name,content,type){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500)}
function safeName(s){return (s||'saillab').replace(/[^a-z0-9-_]+/gi,'_').slice(0,50)}
function downloadJson(s){download(`${safeName(s.name)}.json`,JSON.stringify(s,null,2),'application/json')}
function exportJson(){if(!current){toast('No session selected');return}downloadJson({...current,...currentMeta(),samples,events,durationMs:elapsed()})}
function exportCsv(){if(!current){toast('No session selected');return}const rows=[['timestamp','latitude','longitude','altitude_m','accuracy_m','sog_kn','course_gps_deg'],...samples.map(s=>[new Date(s.t).toISOString(),s.lat,s.lon,s.alt,s.accuracy,s.sog,s.course])];const csv=rows.map(r=>r.map(v=>v==null?'':String(v).replaceAll('"','""')).map(v=>/[,"\n]/.test(v)?`"${v}"`:v).join(',')).join('\r\n');download(`${safeName(current.name)}.csv`,'\ufeff'+csv,'text/csv;charset=utf-8')}
function showView(name){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));document.querySelectorAll('.nav-item').forEach(v=>v.classList.toggle('active',v.dataset.view===name));if(name==='analysis')renderAnalysis();if(name==='data')renderSessions()}
function markTack(type){if(!current){toast('Start a session first');return}if(activeTack){activeTack.endedAt=new Date().toISOString();activeTack.durationMs=activeTack.samples.length>1?activeTack.samples.at(-1).t-activeTack.samples[0].t:0;tackSegments[activeTack.type].push(activeTack);activeTack=null}activeTack={type,startAt:new Date().toISOString(),samples:[],courseSamples:[],distance:0,last:lastFix?{lat:lastFix.coords.latitude,lon:lastFix.coords.longitude,t:Date.now(),course:lastFix.coords.heading==null?null:lastFix.coords.heading}:null};events.push({id:uid(),type:type==='port'?'Port tack start':'Starboard tack start',timestamp:new Date().toISOString(),lat:lastFix?.coords.latitude??null,lon:lastFix?.coords.longitude??null});$('portCount').textContent=tackSegments.port.length+(activeTack?.type==='port'?1:0);$('starboardCount').textContent=tackSegments.starboard.length+(activeTack?.type==='starboard'?1:0);toast(type==='port'?'Port tack marked':'Starboard tack marked')}
function updateWind(){const p=tackSegments.port.length+(activeTack?.type==='port'?1:0),s=tackSegments.starboard.length+(activeTack?.type==='starboard'?1:0);$('portCount').textContent=p;$('starboardCount').textContent=s;$('windResult').textContent=p&&s?'Both tacks have been marked. Wind direction is estimated from GPS course averages when usable legs are recorded on each tack.':'Not enough data to estimate wind direction. Record and mark at least one steady leg on each tack.'}
function importGpx(text){const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw new Error('Invalid GPX file');const pts=[...doc.getElementsByTagNameNS('*','trkpt'),...doc.getElementsByTagNameNS('*','rtept')];if(!pts.length)throw new Error('No track points found');const imported=[];for(const p of pts){const lat=Number(p.getAttribute('lat')),lon=Number(p.getAttribute('lon'));if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;const time=p.getElementsByTagNameNS('*','time')[0]?.textContent;const ele=p.getElementsByTagNameNS('*','ele')[0]?.textContent;imported.push({t:time&&Number.isFinite(Date.parse(time))?Date.parse(time):null,lat,lon,alt:ele!=null&&ele.trim()!==''&&Number.isFinite(Number(ele))?Number(ele):null,accuracy:null,sog:null,course:null,heel:null,pitch:null})}if(!imported.length)throw new Error('No valid GPS points');const s={id:uid(),createdAt:new Date().toISOString(),name:'Imported GPX track',boat:'',boatClass:'',crew:'',location:'',wind:null,setup:'',notes:'Imported from GPX. Timestamp/altitude are null where missing.',status:'imported',durationMs:0,samples:imported,events:[],gpx:true};return dbPut(s).then(()=>s)}
$('sensorBtn').onclick=enableMotion;
$('zeroHeelBtn').onclick=()=>setZero('heel');
$('zeroPitchBtn').onclick=()=>setZero('pitch');
$('lockScreenBtn').onclick=lockScreen;
$('wakeLockBtn').onclick=toggleWakeLock;
$('widgetSelect').onchange=loadWidgetForm;
['widgetWidth','widgetFont','widgetBg','widgetColor'].forEach(id=>$(id).addEventListener('change',saveSelectedWidget));
$('widgetUp').onclick=()=>moveWidget(-1);
$('widgetDown').onclick=()=>moveWidget(1);
$('widgetHide').onclick=()=>{const id=$('widgetSelect').value;widgetPrefs[id]={...(widgetPrefs[id]||{}),hidden:!(widgetPrefs[id]||{}).hidden};localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyWidgetPrefs()};
$('widgetReset').onclick=resetWidgetPrefs;
$('screenLockOverlay').addEventListener('click',e=>{if(e.target.id==='unlockButton')unlockScreen();else handleUnlockTap()});
$('unlockButton').onclick=e=>{e.stopPropagation();unlockScreen()};
$('startBtn').onclick=start;$('pauseBtn').onclick=pause;$('resumeBtn').onclick=resume;$('stopBtn').onclick=finish;$('refreshGps').onclick=requestGps;
document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>showView(b.dataset.view));
document.querySelectorAll('[data-event]').forEach(b=>b.onclick=()=>eventRecord(b.dataset.event));
$('customEventBtn').onclick=()=>{const v=$('customEvent').value.trim();if(v){eventRecord(v);$('customEvent').value=''}else toast('Enter an event name')};
$('noteBtn').onclick=()=>{const v=$('quickNote').value.trim();if(v){eventRecord('Note',v);$('quickNote').value=''}else toast('Enter a note before saving')};
$('exportJson').onclick=exportJson;$('exportCsv').onclick=exportCsv;
$('backupBtn').onclick=async()=>download('saillab-backup.json',JSON.stringify(await dbAll(),null,2),'application/json');
$('gpxInput').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const s=await importGpx(await f.text());$('importMessage').textContent=`Imported ${s.samples.length} GPS points.`;await renderSessions();toast('GPX imported')}catch(err){$('importMessage').textContent=err.message;toast('Import failed')}e.target.value=''};
$('portTack').onclick=()=>{markTack('port');updateWind()};$('starboardTack').onclick=()=>{markTack('starboard');updateWind()};
window.addEventListener('resize',()=>{if(!$('view-analysis').hidden)drawChart()});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&current&&['recording','paused'].includes(current.status))saveCurrent().catch(console.error);
  if(!document.hidden&&locked&&!wakeLock)requestWakeLock();
});
window.addEventListener('beforeunload',()=>{if(current&&['recording','paused'].includes(current.status))saveCurrent().catch(()=>{})});
(async()=>{try{db=await openDb();await renderSessions();if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(console.warn);updateControls();applyWidgetPrefs();updateMotionDisplay()}catch(e){toast('Local database error: '+e.message)}})();
/* Race-line, tack-shift and configurable cockpit modules */
let raceMarks = JSON.parse(localStorage.getItem('saillabRaceMarks') || '{"committee":null,"pin":null}');
tackSegments = JSON.parse(localStorage.getItem('saillabWindLegMeans') || '{"port":[],"starboard":[]}');
let gunDeadline = null, gunTimer = null, raceAutoSwitched = false;
let windBaseline = JSON.parse(localStorage.getItem('saillabWindBaseline') || 'null');
let trimReadings = JSON.parse(localStorage.getItem('saillabTrimReadings') || '[]');
let dashPrefs = JSON.parse(localStorage.getItem('saillabDashPrefs') || '{}');
let raceMap = null, dashMap = null, raceLayers = {}, dashLayers = {};
const DASH_NAMES = {map:'Boat & start-line map',sog:'SOG and COG',heel:'Heel and average',pitch:'Pitch',trim:'Manual trim average',wind:'Wind shift',line:'Start-line timing',chart:'Heel & trim chart'};
function fmtClock(seconds){if(!Number.isFinite(seconds))return '—';const n=Math.max(0,Math.round(Math.abs(seconds)));return `${seconds<0?'-':''}${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`}
function bearingDeg(a,b){const r=x=>x*Math.PI/180, dLon=r(b.lon-a.lon), y=Math.sin(dLon)*Math.cos(r(b.lat)), x=Math.cos(r(a.lat))*Math.sin(r(b.lat))-Math.sin(r(a.lat))*Math.cos(r(b.lat))*Math.cos(dLon);return (Math.atan2(y,x)*180/Math.PI+360)%360}
function angularDelta(a,b){return ((a-b+540)%360)-180}
function circularMean(degs){const vals=degs.filter(Number.isFinite);if(!vals.length)return null;const x=vals.reduce((s,d)=>s+Math.cos(d*Math.PI/180),0),y=vals.reduce((s,d)=>s+Math.sin(d*Math.PI/180),0);return (Math.atan2(y,x)*180/Math.PI+360)%360}
function fmtCoord(p){return p?`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`:'Not pinged'}
function currentPoint(){if(!lastFix)return null;return {lat:lastFix.coords.latitude,lon:lastFix.coords.longitude}}
function saveRaceMarks(){localStorage.setItem('saillabRaceMarks',JSON.stringify(raceMarks));updateRaceEndpoints();updateRaceMetrics();if(raceMap)raceMap._saillabFirstFit=false;if(dashMap)dashMap._saillabFirstFit=false;refreshMaps()}
function pingEndpoint(which){const point=currentPoint();if(!point){toast('Enable GPS first and wait for a position fix');requestGps();return}raceMarks[which]={...point,at:new Date().toISOString()};saveRaceMarks();toast(which==='committee'?'Committee boat ping saved':'Pin ping saved')}
function getLineLengthNm(){return raceMarks.committee&&raceMarks.pin?distanceNm(raceMarks.committee,raceMarks.pin):null}
function crossTrackMeters(point,start,end){if(!point||!start||!end)return null;const rad=x=>x*Math.PI/180,R=6371000,lat0=rad(start.lat);const xy=p=>({x:R*rad(p.lon-start.lon)*Math.cos(lat0),y:R*rad(p.lat-start.lat)});const a=xy(start),b=xy(end),p=xy(point),dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;if(!len2)return Math.hypot(p.x-a.x,p.y-a.y);const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2));return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy))}
function updateRaceEndpoints(){if($('committeeStatus')){$('committeeStatus').textContent=raceMarks.committee?'Ping saved':'Not pinged';$('committeeCoords').textContent=fmtCoord(raceMarks.committee);$('pinStatus').textContent=raceMarks.pin?'Ping saved':'Not pinged';$('pinCoords').textContent=fmtCoord(raceMarks.pin);const len=getLineLengthNm();$('lineLength').innerHTML=len==null?'—<small> nm</small>':`${len.toFixed(3)}<small> nm</small>`}}
function remainingGunSeconds(){return gunDeadline==null?null:(gunDeadline-Date.now())/1000}
function updateRaceMetrics(){if(!$('lineDistance'))return;const point=currentPoint(),lineReady=raceMarks.committee&&raceMarks.pin&&point;let dist=null,seconds=null;if(lineReady){dist=crossTrackMeters(point,raceMarks.committee,raceMarks.pin);const sog=lastFix?.coords.speed==null?null:lastFix.coords.speed*KNOTS_PER_MS;if(sog!=null&&sog>0.15)seconds=Math.abs(dist)/1852/sog*3600}
 $('lineDistance').innerHTML=dist==null?'—<small> m</small>':`${Math.round(Math.abs(dist))}<small> m</small>`;$('timeToLine').textContent=seconds==null?'—':fmtClock(seconds);const gun=remainingGunSeconds();$('gunCountdown').textContent=gun==null?fmtClock(Number($('gunSeconds')?.value||0)):fmtClock(gun);if(gun!=null){$('gunStatus').textContent=gun<=0?'GUN TIME':'Countdown running'}else $('gunStatus').textContent='Countdown not running';let burn=gun!=null&&seconds!=null?gun-seconds:null;$('timeToBurn').textContent=burn==null?'—':fmtClock(burn);$('burnHint').textContent=burn==null?'Set gun countdown and get a GPS fix':burn>=0?'Positive = time to burn / slow down':'Negative = estimated late';if($('dashBurn')){$('dashBurn').textContent=burn==null?'—':fmtClock(burn);$('dashTimeToLine').textContent=seconds==null?'—':fmtClock(seconds)}}
function finishGunCountdown(){if(gunTimer)clearInterval(gunTimer);gunTimer=null;$('gunCountdown').textContent='00:00';$('gunStatus').textContent='START — switching to cockpit';toast('Start! Switching to cockpit');if(!raceAutoSwitched){raceAutoSwitched=true;setTimeout(()=>showView('cockpit'),900)}}
function ensureGunTimer(){if(gunTimer)clearInterval(gunTimer);gunTimer=setInterval(()=>{updateRaceMetrics();if(remainingGunSeconds()<=0){gunDeadline=null;finishGunCountdown()}},100)}
function startGunCountdown(){const sec=Math.max(0,Number($('gunSeconds').value)||0);if(sec<=0){toast('Set a countdown greater than zero');return}gunDeadline=Date.now()+sec*1000;localStorage.setItem('saillabGunSeconds',String(sec));raceAutoSwitched=false;ensureGunTimer();updateRaceMetrics();toast('Start countdown running')}
function syncGunToMinute(){const now=Date.now();if(gunDeadline!=null){const remaining=Math.max(0,Math.ceil((gunDeadline-now)/1000));const snapped=Math.floor(remaining/60)*60;if(snapped<=0){gunDeadline=now;updateRaceMetrics();finishGunCountdown();return}gunDeadline=now+snapped*1000;$('gunSeconds').value=String(snapped);localStorage.setItem('saillabGunSeconds',String(snapped));if(!gunTimer)ensureGunTimer();updateRaceMetrics();toast(`Countdown synced to ${fmtClock(snapped)}`);return}const selected=Math.max(0,Number($('gunSeconds').value)||0);const snapped=Math.floor(selected/60)*60;$('gunSeconds').value=String(snapped);localStorage.setItem('saillabGunSeconds',String(snapped));updateRaceMetrics();toast(`Set to whole minute: ${fmtClock(snapped)}`)}
function adjustGunMinutes(delta){const input=$('gunSeconds');const next=Math.max(0,(Number(input.value)||0)+delta*60);input.value=String(next);localStorage.setItem('saillabGunSeconds',String(next));if(gunDeadline!=null){gunDeadline+=delta*60000;if(gunTimer==null&&remainingGunSeconds()>0){gunTimer=setInterval(()=>{updateRaceMetrics();if(remainingGunSeconds()<=0){clearInterval(gunTimer);gunTimer=null;$('gunCountdown').textContent='00:00';$('gunStatus').textContent='START — switching to cockpit';toast('Start! Switching to cockpit');if(!raceAutoSwitched){raceAutoSwitched=true;setTimeout(()=>showView('cockpit'),900)}}},100)}}updateRaceMetrics()}
function resetGunCountdown(){if(gunTimer)clearInterval(gunTimer);gunTimer=null;gunDeadline=null;raceAutoSwitched=false;updateRaceMetrics()}
function initMap(containerId,which){if(typeof L==='undefined')return null;const el=$(containerId);if(!el)return null;const map=L.map(el,{zoomControl:true,attributionControl:true}).setView([41.0,9.0],10);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);const layers={};layers.boat=L.circleMarker([41,9],{radius:7,color:'#54e0c0',fillColor:'#54e0c0',fillOpacity:1,weight:2}).bindTooltip('Your boat');layers.committee=L.circleMarker([41,9],{radius:7,color:'#a78bfa',fillColor:'#a78bfa',fillOpacity:1,weight:2}).bindTooltip('Committee boat');layers.pin=L.circleMarker([41,9],{radius:7,color:'#ffb454',fillColor:'#ffb454',fillOpacity:1,weight:2}).bindTooltip('Pin');layers.line=L.polyline([[41,9],[41,9]],{color:'#f1f6fa',weight:3,dashArray:'7 6'});Object.values(layers).forEach(l=>l.addTo(map));if(which==='race'){raceMap=map;raceLayers=layers}else{dashMap=map;dashLayers=layers}refreshMap(which);return map}
function refreshMap(which){const map=which==='race'?raceMap:dashMap,layers=which==='race'?raceLayers:dashLayers;if(!map||!layers)return;const p=currentPoint();if(p){layers.boat.setLatLng([p.lat,p.lon]);layers.boat.setStyle({opacity:1,fillOpacity:1})}else layers.boat.setStyle({opacity:0,fillOpacity:0});for(const k of ['committee','pin']){const v=raceMarks[k];if(v){layers[k].setLatLng([v.lat,v.lon]);layers[k].setStyle({opacity:1,fillOpacity:1})}else layers[k].setStyle({opacity:0,fillOpacity:0})}if(raceMarks.committee&&raceMarks.pin)layers.line.setLatLngs([[raceMarks.committee.lat,raceMarks.committee.lon],[raceMarks.pin.lat,raceMarks.pin.lon]]);else layers.line.setLatLngs([]);const pts=[p,raceMarks.committee,raceMarks.pin].filter(Boolean).map(x=>[x.lat,x.lon]);if(pts.length&&map._saillabFirstFit!==true){map.fitBounds(pts,{padding:[25,25],maxZoom:16});map._saillabFirstFit=true}}
function refreshMaps(){refreshMap('race');refreshMap('dash')}
function renderCockpit(){const p=currentPoint(),speed=lastFix?.coords.speed==null?null:lastFix.coords.speed*KNOTS_PER_MS,course=lastFix?.coords.heading;const heels=samples.map(s=>s.heel).filter(Number.isFinite),avgHeel=heels.length?heels.reduce((a,b)=>a+b,0)/heels.length:null;const trimVals=trimReadings.map(x=>x.value).filter(Number.isFinite),avgTrim=trimVals.length?trimVals.reduce((a,b)=>a+b,0)/trimVals.length:null;
 $('dashSog').textContent=speed==null?'—':speed.toFixed(1);$('dashCog').textContent=course==null?'—':`${Math.round(course)}°`;$('dashHeel').textContent=correctedMotion('heel')==null?'—':correctedMotion('heel').toFixed(1);$('dashHeelAvg').textContent=avgHeel==null?'—':`${avgHeel.toFixed(1)}°`;$('dashPitch').textContent=correctedMotion('pitch')==null?'—':correctedMotion('pitch').toFixed(1);$('trimAverage').textContent=avgTrim==null?'—':avgTrim.toFixed(2);$('trimCount').textContent=`${trimVals.length} manually logged reading${trimVals.length===1?'':'s'}`;const w=windEstimate();$('dashWindShift').textContent=w?.delta==null?'—':`${Math.abs(w.delta).toFixed(0)}${w.delta>0?'↻':w.delta<0?'↺':''}`;$('dashWindLabel').textContent=w?.delta==null?'Mark both tacks in Wind':w.delta>0?'Right shift':w.delta<0?'Left shift':'No change from baseline';updateRaceMetrics();drawHeelTrimChart();refreshMaps()}
function dashboardConfig(){const grid=$('dashboardGrid');if(!grid)return;const cards=[...grid.querySelectorAll('[data-dash-widget]')];cards.forEach(card=>{const id=card.dataset.dashWidget, pref=dashPrefs[id]||{};card.hidden=pref.hidden===true;card.classList.toggle('dash-wide',pref.wide===true);});cards.sort((a,b)=>(dashPrefs[a.dataset.dashWidget]?.order??100)-(dashPrefs[b.dataset.dashWidget]?.order??100)).forEach(card=>grid.appendChild(card));const toggles=$('dashboardToggles');if(toggles){toggles.innerHTML='';cards.forEach(card=>{const id=card.dataset.dashWidget,label=document.createElement('label');label.className='toggle-item';const input=document.createElement('input');input.type='checkbox';input.checked=dashPrefs[id]?.hidden!==true;input.onchange=()=>{dashPrefs[id]={...(dashPrefs[id]||{}),hidden:!input.checked};localStorage.setItem('saillabDashPrefs',JSON.stringify(dashPrefs));dashboardConfig()};label.append(input,document.createTextNode(DASH_NAMES[id]||id));toggles.append(label)})}}
function saveDashOrder(){[...$('dashboardGrid').querySelectorAll('[data-dash-widget]')].forEach((el,i)=>{const id=el.dataset.dashWidget;dashPrefs[id]={...(dashPrefs[id]||{}),order:i}});localStorage.setItem('saillabDashPrefs',JSON.stringify(dashPrefs));dashboardConfig()}
function setupDragWidgets(){let dragged=null;document.querySelectorAll('[data-dash-widget]').forEach(card=>{card.addEventListener('dragstart',e=>{dragged=card;card.classList.add('dragging');e.dataTransfer.effectAllowed='move'});card.addEventListener('dragend',()=>{card.classList.remove('dragging');dragged=null});card.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move'});card.addEventListener('drop',e=>{e.preventDefault();if(dragged&&dragged!==card){const rect=card.getBoundingClientRect(),after=e.clientY>rect.top+rect.height/2;card.parentNode.insertBefore(dragged,after?card.nextSibling:card);saveDashOrder()}})})}
function drawHeelTrimChart(){const c=$('heelTrimChart');if(!c||!c.offsetParent)return;const rect=c.getBoundingClientRect(),ratio=window.devicePixelRatio||1,w=Math.max(260,rect.width),h=150;c.width=w*ratio;c.height=h*ratio;const ctx=c.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);ctx.strokeStyle='#294054';ctx.lineWidth=1;for(let i=0;i<4;i++){const y=12+(h-24)*i/3;ctx.beginPath();ctx.moveTo(12,y);ctx.lineTo(w-8,y);ctx.stroke()}const heel=samples.map(s=>s.heel).filter(Number.isFinite).slice(-80),trim=trimReadings.slice(-80).map(x=>x.value).filter(Number.isFinite);const all=[...heel,...trim];if(!all.length){ctx.fillStyle='#9eb0c0';ctx.font='12px sans-serif';ctx.fillText('Record a session and log trim values',12,30);return}let min=Math.min(...all),max=Math.max(...all);if(max-min<1){max+=1;min-=1}function line(vals,color){if(vals.length<2)return;ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();vals.forEach((v,i)=>{const x=12+(w-24)*i/(vals.length-1),y=h-12-(v-min)/(max-min)*(h-24);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke()}line(heel,'#ff729f');line(trim,'#64d9ff');ctx.fillStyle='#ff729f';ctx.fillText('Heel',12,11);ctx.fillStyle='#64d9ff';ctx.fillText('Trim',58,11)}
function logTrim(){const value=Number($('trimValue').value);if($('trimValue').value===''||!Number.isFinite(value)){toast('Enter a numeric trim value first');return}trimReadings.push({value,t:Date.now(),sessionId:current?.id||null});if(trimReadings.length>1000)trimReadings=trimReadings.slice(-1000);localStorage.setItem('saillabTrimReadings',JSON.stringify(trimReadings));$('trimValue').value='';renderCockpit();toast('Trim reading logged')}
function meanForSegments(list){const vals=list.map(seg=>Number.isFinite(seg.meanCourse)?seg.meanCourse:circularMean(seg.courseSamples||seg.samples?.map(s=>s.course)||[])).filter(Number.isFinite);return vals.length?circularMean(vals):null}
function persistWindLegMeans(){const compact={port:tackSegments.port.map(seg=>({meanCourse:Number.isFinite(seg.meanCourse)?seg.meanCourse:circularMean(seg.courseSamples||[])})).filter(seg=>Number.isFinite(seg.meanCourse)),starboard:tackSegments.starboard.map(seg=>({meanCourse:Number.isFinite(seg.meanCourse)?seg.meanCourse:circularMean(seg.courseSamples||[])})).filter(seg=>Number.isFinite(seg.meanCourse))};localStorage.setItem('saillabWindLegMeans',JSON.stringify(compact))}
function windEstimate(){const port=meanForSegments(tackSegments.port),star=meanForSegments(tackSegments.starboard);if(port==null||star==null)return null;const dir=(port+angularDelta(star,port)/2+360)%360;return {port,star,direction:dir,delta:windBaseline==null?null:angularDelta(dir,windBaseline)}}
function updateWind(){const portCount=tackSegments.port.length+(activeTack?.type==='port'?1:0),starCount=tackSegments.starboard.length+(activeTack?.type==='starboard'?1:0);$('portCount').textContent=portCount;$('starboardCount').textContent=starCount;if($('cockpitPortCount'))$('cockpitPortCount').textContent=portCount;if($('cockpitStarboardCount'))$('cockpitStarboardCount').textContent=starCount;const p=meanForSegments(tackSegments.port),s=meanForSegments(tackSegments.starboard);$('portMean').textContent=`Average course ${p==null?'—':Math.round(p)+'°'}`;$('starboardMean').textContent=`Average course ${s==null?'—':Math.round(s)+'°'}`;const est=windEstimate();if(!est){$('windDirection').textContent='—';$('leftShift').textContent='—';$('rightShift').textContent='—';$('windBaselineLabel').textContent=windBaseline==null?'Baseline not set':`Baseline ${Math.round(windBaseline)}°`; $('windResult').textContent='Need at least one completed, usable upwind leg on both port and starboard tack. Record several steady GPS course samples per leg.';if($('dashWindShift')){$('dashWindShift').textContent='—';$('dashWindLabel').textContent='Record steady legs on both tacks'}return}
 $('windDirection').textContent=String(Math.round(est.direction)).padStart(3,'0');$('windNeedle').style.transform=`rotate(${est.direction}deg)`;$('windBaselineLabel').textContent=windBaseline==null?'Baseline not set':`Baseline ${Math.round(windBaseline)}°`;const delta=est.delta;$('leftShift').textContent=delta==null?'—':`${delta<0?Math.abs(delta).toFixed(0)+'°':'0°'}`;$('rightShift').textContent=delta==null?'—':`${delta>0?delta.toFixed(0)+'°':'0°'}`;$('windResult').textContent=delta==null?'Estimated direction available. Set it as a baseline to show subsequent left/right shifts.':delta>0?`RIGHT SHIFT: wind direction has moved ${delta.toFixed(1)}° clockwise from baseline.`:delta<0?`LEFT SHIFT: wind direction has moved ${Math.abs(delta).toFixed(1)}° counter-clockwise from baseline.`:'Wind direction is unchanged from baseline.';if($('dashWindShift')){$('dashWindShift').textContent=delta==null?'—':`${Math.abs(delta).toFixed(0)}${delta>0?'↻':delta<0?'↺':''}`;$('dashWindLabel').textContent=delta==null?'Set a baseline':delta>0?'Right shift':delta<0?'Left shift':'No change'}}
// Replace the older marker implementation with a segment-aware tack recorder.
function markTack(type){if(!current){toast('Start a session before marking a tack');return}if(activeTack){activeTack.endedAt=new Date().toISOString();activeTack.durationMs=activeTack.samples.length>1?activeTack.samples.at(-1).t-activeTack.samples[0].t:0;activeTack.meanCourse=circularMean(activeTack.courseSamples);if(activeTack.samples.length>=3&&activeTack.courseSamples.length>=2)tackSegments[activeTack.type].push(activeTack);persistWindLegMeans();activeTack=null}activeTack={type,startAt:new Date().toISOString(),samples:[],courseSamples:[],distance:0,last:lastFix?{lat:lastFix.coords.latitude,lon:lastFix.coords.longitude,t:Date.now(),course:lastFix.coords.heading==null?null:lastFix.coords.heading}:null};if(lastFix?.coords.heading!=null)activeTack.courseSamples.push(lastFix.coords.heading);events.push({id:uid(),type:type==='port'?'Port tack start':'Starboard tack start',timestamp:new Date().toISOString(),lat:lastFix?.coords.latitude??null,lon:lastFix?.coords.longitude??null});updateWind();toast(type==='port'?'Port tack leg started':'Starboard tack leg started')}
function initRaceFeature(){updateRaceEndpoints();$('gunSeconds').value=localStorage.getItem('saillabGunSeconds')||'300';$('pingCommittee').onclick=()=>pingEndpoint('committee');$('pingPin').onclick=()=>pingEndpoint('pin');$('gunStart').onclick=startGunCountdown;$('gunSync').onclick=syncGunToMinute;$('gunMinusMinute').onclick=()=>adjustGunMinutes(-1);$('gunPlusMinute').onclick=()=>adjustGunMinutes(1);$('gunReset').onclick=resetGunCountdown;$('centerRaceMap').onclick=()=>{if(raceMap){const pts=[currentPoint(),raceMarks.committee,raceMarks.pin].filter(Boolean).map(x=>[x.lat,x.lon]);if(pts.length)raceMap.fitBounds(pts,{padding:[25,25],maxZoom:16})}};$('dashboardRaceBtn').onclick=()=>showView('race');$('editDashboard').onclick=()=>{$('dashboardEditor').hidden=!$('dashboardEditor').hidden};$('dashboardReset').onclick=()=>{dashPrefs={};localStorage.removeItem('saillabDashPrefs');dashboardConfig()};$('logTrim').onclick=logTrim;$('setWindBaseline').onclick=()=>{const w=windEstimate();if(!w){toast('Record both tacks first');return}windBaseline=w.direction;localStorage.setItem('saillabWindBaseline',JSON.stringify(windBaseline));updateWind();renderCockpit();toast('Wind baseline set')};$('resetWindData').onclick=()=>{if(!confirm('Clear saved port/starboard legs and the wind-shift baseline?'))return;windBaseline=null;tackSegments={port:[],starboard:[]};localStorage.removeItem('saillabWindBaseline');localStorage.removeItem('saillabWindLegMeans');updateWind();renderCockpit();toast('Wind legs and baseline cleared')};
 $('portTack').onclick=()=>{markTack('port')};$('starboardTack').onclick=()=>{markTack('starboard')};$('cockpitPortTack').onclick=()=>{markTack('port')};$('cockpitStarboardTack').onclick=()=>{markTack('starboard')};$('cockpitSetWindBaseline').onclick=()=>{const w=windEstimate();if(!w){toast('Record usable legs on both tacks first');return}windBaseline=w.direction;localStorage.setItem('saillabWindBaseline',JSON.stringify(windBaseline));updateWind();renderCockpit();toast('Wind baseline set')};
 dashboardConfig();setupDragWidgets();
}
const originalShowView=showView;
showView=function(name){originalShowView(name);if(name==='race'){if(!raceMap&&typeof L!=='undefined')initMap('raceMap','race');setTimeout(()=>raceMap?.invalidateSize(),80);refreshMap('race')}if(name==='cockpit'){if(!dashMap&&typeof L!=='undefined')initMap('dashboardMap','dash');setTimeout(()=>dashMap?.invalidateSize(),80);refreshMap('dash');renderCockpit()}if(name==='wind'){showView('cockpit');return}};
window.addEventListener('resize',()=>{if($('view-cockpit')?.classList.contains('active')){drawHeelTrimChart();dashMap?.invalidateSize()}if($('view-race')?.classList.contains('active'))raceMap?.invalidateSize()});
const previousRequestGps=requestGps;
requestGps=function(){previousRequestGps();setTimeout(()=>{updateRaceMetrics();renderCockpit()},300)};
const previousUpdateStats=updateStats;
updateStats=function(){previousUpdateStats();renderCockpit()};
const previousOrientationDisplay=updateMotionDisplay;
updateMotionDisplay=function(){previousOrientationDisplay();renderCockpit()};
const previousApplyPrefs=applyWidgetPrefs;
applyWidgetPrefs=function(){previousApplyPrefs();renderCockpit()};
initRaceFeature();updateWind();updateRaceMetrics();renderCockpit();
