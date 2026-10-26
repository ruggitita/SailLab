/* SailLab — local data storage, no server upload. GPS access depends on browser permissions and limitations. */
const $ = id => document.getElementById(id);
const DB_NAME='SailLabDB', DB_VERSION=1, STORE='sessions';
let db, watchId=null, current=null, timerId=null, lastFix=null, lastSampleAt=null, sessionStartMs=null, elapsedBeforePause=0, paused=false, samples=[], events=[], tackSegments={port:[],starboard:[]}, activeTack=null, toastTimer, motion={heel:null,pitch:null,enabled:false};
let dockTunePhotos=[];
let heelHistory=[],pitchHistory=[];
let zeroOffsets=JSON.parse(localStorage.getItem('saillabZeroOffsets')||'{"heel":0,"pitch":0}');
let widgetPrefs=JSON.parse(localStorage.getItem('saillabWidgetPrefs')||'{}');
let wakeLock=null, locked=false, unlockHoldTimer=null;
const KNOTS_PER_MS=1.943844;
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2600)}
function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>req.result.createObjectStore(STORE,{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
function dbAll(){return new Promise((resolve,reject)=>{const r=db.transaction(STORE).objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error)})}
function dbPut(obj){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(obj);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}
function dbDelete(id){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}
function uid(){return crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random().toString(16).slice(2)}
function fmtTime(ms){const s=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`}
function elapsed(){return elapsedBeforePause+(sessionStartMs&&!paused?Date.now()-sessionStartMs:0)}
const META_FIELDS=['name','boat','crew','location','opponents','onboardFeeling','wind','waves','windDirectionInput','currentDirection','gustiness','waveState','weatherNotes','sailModel','mast','platform','foil','foilSettings','rudder','rudderSettings','mainsail','jib','gennaker','materialNotes','shrouds','forestay','prebend','spreaderPosition','diamond','rake','d1','d2','v1','v2','dockTuneNotes'];
function currentMeta(){const meta={name:$('sessionName').value.trim()||'Sailing session',dockTunePhotos:[...dockTunePhotos]};for(const id of META_FIELDS.slice(1)){const el=$(id);if(!el)continue;meta[id]=el.value===''?null:el.value.trim?el.value.trim():el.value;if(['wind','waves','windDirectionInput','currentDirection','gustiness','waveState'].includes(id))meta[id]=el.value===''?null:Number(el.value)}return meta}

function correctedMotion(channel){
  return motion[channel]==null ? null : motion[channel] - (Number(zeroOffsets[channel]) || 0);
}
function updateMotionDisplay(){
  const heel=correctedMotion('heel'), pitch=correctedMotion('pitch');
  if($('heel'))$('heel').textContent = heel==null ? '—' : `${Math.round(heel)}`;
  if($('pitch'))$('pitch').textContent = pitch==null ? '—' : `${(Math.round(pitch / 0.5) * 0.5).toFixed(1)}`;
  $('zeroStatus').textContent=`Zero offsets — HEEL: ${(Number(zeroOffsets.heel)||0).toFixed(1)}°, PITCH: ${(Number(zeroOffsets.pitch)||0).toFixed(1)}°.`;
}
function onOrientation(e){
  // DeviceOrientationEvent angles describe the phone, not the boat; secure mounting/alignment is required.
  if(Number.isFinite(e.gamma)) motion.heel=e.gamma;
  if(Number.isFinite(e.beta)) motion.pitch=e.beta;
  motion.enabled=true;
  const heel=correctedMotion('heel'),pitch=correctedMotion('pitch'),now=Date.now(); if(Number.isFinite(heel)){heelHistory.push({t:now,value:heel});heelHistory=heelHistory.filter(x=>now-x.t<=60000)} if(Number.isFinite(pitch)){pitchHistory.push({t:now,value:pitch});pitchHistory=pitchHistory.filter(x=>now-x.t<=60000)}
  updateMotionDisplay();
}
async function enableMotion(){
  try{
    if(!('DeviceOrientationEvent' in window)){toast('Motion sensors are not supported by this browser');return}
    if(typeof DeviceOrientationEvent.requestPermission==='function'){
      const permission=await DeviceOrientationEvent.requestPermission();
      if(permission!=='granted'){toast('Motion sensor permission was not granted');return}
    }
    window.addEventListener('deviceorientation',onOrientation,true);motion.enabled=true;if($('sensorBtn'))$('sensorBtn').textContent='Disable IMU / motion sensors';
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
  const grid=document.querySelector('#dashboardGrid');
  if(!grid)return;
  const cards=[...grid.querySelectorAll('[data-widget]')];
  cards.forEach(card=>{
    const id=card.dataset.widget, p=widgetPrefs[id]||{};
    card.classList.toggle('widget-full',(p.width||(['map','live-sog','wind','chart'].includes(id)?'full':'half'))==='full');
    card.classList.toggle('dash-wide',(p.width||(['map','live-sog','wind','chart'].includes(id)?'full':'half'))==='full');
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
  const cards=[...document.querySelectorAll('#dashboardGrid [data-widget]')];
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
  locked=true;
  $('screenLockOverlay').classList.add('active');
  $('screenLockOverlay').setAttribute('aria-hidden','false');
  document.body.classList.add('app-locked');
  $('tapProgress').textContent='HOLD FOR 3 SECONDS';
  requestWakeLock();
}
function unlockScreen(){
  locked=false;
  $('screenLockOverlay').classList.remove('active');
  $('screenLockOverlay').setAttribute('aria-hidden','true');
  document.body.classList.remove('app-locked');
  clearTimeout(unlockHoldTimer); unlockHoldTimer=null;
}
function startUnlockHold(){
  if(!locked)return;
  $('tapProgress').textContent='Keep holding for 3 seconds…';
  clearTimeout(unlockHoldTimer);
  unlockHoldTimer=setTimeout(()=>{unlockScreen();toast('Screen unlocked')},3000);
}
function cancelUnlockHold(){
  clearTimeout(unlockHoldTimer); unlockHoldTimer=null;
  if(locked)$('tapProgress').textContent='HOLD FOR 3 SECONDS';
}
function loadEditorWidgetForm(){
 const id=$('editorWidgetSelect')?.value;if(!id)return;
 const p=widgetPrefs[id]||{};
 $('editorWidgetWidth').value=p.width||'half';$('editorWidgetFont').value=p.font||'medium';
 $('editorWidgetBg').value=p.bg||'#101f2e';$('editorWidgetColor').value=p.color||'#f1f6fa';
 $('editorWidgetHide').textContent=p.hidden?'Show widget':'Hide widget';
}
function saveEditorWidget(){
 const id=$('editorWidgetSelect').value;
 widgetPrefs[id]={...(widgetPrefs[id]||{}),width:$('editorWidgetWidth').value,font:$('editorWidgetFont').value,bg:$('editorWidgetBg').value,color:$('editorWidgetColor').value};
 localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyWidgetPrefs();applyDashboardLayout();loadEditorWidgetForm();
}
function openDashboardEditor(){
 if(locked)unlockScreen();
 $('dashboardEditor').hidden=false;document.body.classList.add('dashboard-editing');
 loadEditorWidgetForm();$('dashboardEditor').scrollIntoView({behavior:'smooth',block:'start'});
}
function closeDashboardEditor(){
 $('dashboardEditor').hidden=true;document.body.classList.remove('dashboard-editing');
}
async function enterDashboardFullscreen(){
 closeDashboardEditor();
 document.body.classList.add('cockpit-presentation','dashboard-fullscreen');
 $('exitDashboardBtn').hidden=false;
 try{if(!document.fullscreenElement&&document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen()}catch(e){/* CSS fullscreen fallback remains available */}
 try{if('wakeLock' in navigator&&!wakeLock)wakeLock=await navigator.wakeLock.request('screen')}catch(e){}
 toast('Dashboard full screen · tap Exit to return');
}
async function exitDashboardFullscreen(){
 document.body.classList.remove('cockpit-presentation','dashboard-fullscreen');$('exitDashboardBtn').hidden=true;
 if(document.fullscreenElement&&document.exitFullscreen){try{await document.exitFullscreen()}catch(e){}}
 if(wakeLock){try{await wakeLock.release()}catch(e){}wakeLock=null}
}
function setupEditorControls(){
 $('customizeDashboard').onclick=openDashboardEditor;$('closeDashboardEditor').onclick=closeDashboardEditor;
 $('editorDoneLock').onclick=enterDashboardFullscreen;$('lockDashboardBtn').onclick=enterDashboardFullscreen;$('exitDashboardBtn').onclick=exitDashboardFullscreen;
 $('editorWidgetSelect').onchange=loadEditorWidgetForm;
 ['editorWidgetWidth','editorWidgetFont','editorWidgetBg','editorWidgetColor'].forEach(id=>$(id).addEventListener('change',saveEditorWidget));
 $('editorWidgetUp').onclick=()=>{ $('widgetSelect').value=$('editorWidgetSelect').value;moveWidget(-1);loadEditorWidgetForm() };
 $('editorWidgetDown').onclick=()=>{ $('widgetSelect').value=$('editorWidgetSelect').value;moveWidget(1);loadEditorWidgetForm() };
 $('editorWidgetHide').onclick=()=>{const id=$('editorWidgetSelect').value;widgetPrefs[id]={...(widgetPrefs[id]||{}),hidden:!(widgetPrefs[id]||{}).hidden};localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyWidgetPrefs();applyDashboardLayout();loadEditorWidgetForm()};
 $('editorResetLayout').onclick=()=>{widgetPrefs={};localStorage.removeItem('saillabWidgetPrefs');applyDashboardLayout('race');applyWidgetPrefs();loadEditorWidgetForm();toast('Dashboard layout reset')};
 document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&document.body.classList.contains('dashboard-fullscreen')){document.body.classList.remove('cockpit-presentation','dashboard-fullscreen');$('exitDashboardBtn').hidden=true}});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('dashboard-fullscreen'))exitDashboardFullscreen()});
}
function resetWidgetPrefs(){
  widgetPrefs={};dashPrefs={};localStorage.removeItem('saillabWidgetPrefs');localStorage.removeItem('saillabDashPrefs');applyWidgetPrefs();toast('Widget layout reset');
}


async function persistSessionMeta(){if(!current)return;current={...current,...currentMeta(),samples:[...samples],events:[...events]};await dbPut(current)}
function renderDockTunePhotos(){const host=$('dockTunePhotosPreview');if(!host)return;host.innerHTML='';dockTunePhotos.forEach((src,index)=>{const wrap=document.createElement('div');wrap.className='dock-photo';const img=document.createElement('img');img.src=src;img.alt=`Dock tune photo ${index+1}`;const remove=document.createElement('button');remove.type='button';remove.className='secondary compact';remove.textContent='Remove';remove.onclick=()=>{dockTunePhotos.splice(index,1);renderDockTunePhotos();persistSessionMeta().catch(console.error)};wrap.append(img,remove);host.appendChild(wrap)})}
function compressPhoto(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=reject;reader.onload=()=>{const img=new Image();img.onerror=reject;img.onload=()=>{const scale=Math.min(1,1280/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/jpeg',0.78))};img.src=reader.result};reader.readAsDataURL(file)})}
async function handleDockPhotos(files){for(const file of [...files]){if(!file.type.startsWith('image/'))continue;try{if(dockTunePhotos.length>=8){toast('Maximum 8 dock tune photos');break}dockTunePhotos.push(await compressPhoto(file))}catch(e){console.warn(e);toast('Could not add one of the photos')}}renderDockTunePhotos();persistSessionMeta().catch(console.error)}
function createSession(){return {id:uid(),createdAt:new Date().toISOString(),...currentMeta(),status:'recording',startedAt:new Date().toISOString(),durationMs:0,samples:[],events:[],gpx:false}}
async function saveCurrent(){if(!current)return;current={...current,...currentMeta(),samples:[...samples],events:[...events],durationMs:elapsed(),status:paused?'paused':'recording',updatedAt:new Date().toISOString()};await dbPut(current)}
async function start(){if(current&&current.status==='recording'){toast('Session already running');return}if(!navigator.geolocation){toast('Geolocation is not supported');return}if(!window.isSecureContext){toast('GPS requires HTTPS. Publish the app over HTTPS.');return}
 if(!current||['finished','imported'].includes(current.status)){current=createSession();samples=[];events=[];elapsedBeforePause=0;sessionStartMs=Date.now();paused=false}
 else{sessionStartMs=Date.now();paused=false}
 updateControls();requestGps();timerId=setInterval(()=>{if(current&&!paused){$('duration').textContent=fmtTime(elapsed());saveCurrent().catch(console.error)}},5000);toast('Recording started')}
function requestGps(){if(watchId!==null)return;let fixCount=0;watchId=navigator.geolocation.watchPosition(pos=>{fixCount++;lastFix=pos;const c=pos.coords;const speed=c.speed==null?null:Math.max(0,c.speed*KNOTS_PER_MS);const sample={t:pos.timestamp||Date.now(),lat:c.latitude,lon:c.longitude,alt:c.altitude==null?null:c.altitude,accuracy:c.accuracy==null?null:c.accuracy,sog:speed,course:c.heading==null?null:c.heading,heel:correctedMotion('heel'),pitch:correctedMotion('pitch')};if(current&&!paused){samples.push(sample);current.samples=samples;if(samples.length>100000){samples.shift()}if(lastSampleAt){const dt=(sample.t-lastSampleAt)/1000;if(dt>0)$('sampleRate').textContent=(1/dt).toFixed(1)+' Hz effective'}lastSampleAt=sample.t;updateStats();if(activeTack){const prev=activeTack.last;if(prev&&sample.course!=null)activeTack.courseSamples.push(sample.course);activeTack.last=sample;activeTack.distance+=prev?distanceNm(prev,sample):0;activeTack.samples.push(sample)}}
 $('gpsBadge').className='status ok';$('gpsBadge').innerHTML='<span class="dot"></span> GPS active';if($('sog'))$('sog').textContent=speed==null?'—':speed.toFixed(1);if($('course'))$('course').textContent=sample.course==null?'—':Math.round(sample.course);if($('accuracy'))$('accuracy').textContent=sample.accuracy==null?'—':Math.round(sample.accuracy);if($('coords'))$('coords').textContent=`${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`;if($('samples'))$('samples').textContent=samples.length;if(typeof updateRaceMetrics==='function')updateRaceMetrics();if(typeof renderCockpit==='function')renderCockpit();},err=>{$('gpsBadge').className='status bad';$('gpsBadge').innerHTML='<span class="dot"></span> GPS unavailable';toast(({1:'GPS permission denied. Check your browser settings.',2:'GPS signal unavailable.',3:'GPS timed out. Try again outdoors.'})[err.code]||'GPS error');if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}if($('settingsGpsToggle'))$('settingsGpsToggle').textContent='Enable GPS'}, {enableHighAccuracy:true,maximumAge:1000,timeout:15000})}
function stopGps(){if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}}
function updateControls(){const active=!!current&&current.status==='recording';$('startBtn').disabled=active;$('pauseBtn').disabled=!active;$('resumeBtn').disabled=!(current&&paused);$('stopBtn').disabled=!current||!['recording','paused'].includes(current.status)}
async function pause(){if(!current||paused)return;elapsedBeforePause=elapsed();paused=true;sessionStartMs=null;await saveCurrent();updateControls();toast('Session paused')}
async function resume(){if(!current||!paused)return;sessionStartMs=Date.now();paused=false;await saveCurrent();updateControls();requestGps();toast('Recording resumed')}
async function finish(){if(!current)return;current.durationMs=elapsed();current.status='finished';current.finishedAt=new Date().toISOString();current={...current,...currentMeta(),samples:[...samples],events:[...events]};await dbPut(current);stopGps();clearInterval(timerId);timerId=null;sessionStartMs=null;paused=false;updateControls();renderSessions();renderAnalysis();toast('Session saved on this device')}
function updateStats(){const valid=samples.map(s=>s.sog).filter(Number.isFinite);$('avgSpeed').textContent=valid.length?(valid.reduce((a,b)=>a+b,0)/valid.length).toFixed(1):'—';$('maxSpeed').textContent=valid.length?Math.max(...valid).toFixed(1):'—';if($('samples'))$('samples').textContent=samples.length;const liveSog=$('sog');if(liveSog)liveSog.textContent=lastFix?.coords.speed==null?'—':(lastFix.coords.speed*KNOTS_PER_MS).toFixed(1);const duration=$('duration');if(duration)duration.textContent=fmtTime(elapsed())}
function eventRecord(type,note=''){if(!current){toast('Start a session before logging events');return}const e={id:uid(),type,note,timestamp:new Date().toISOString(),elapsedMs:elapsed(),lat:lastFix?.coords.latitude??null,lon:lastFix?.coords.longitude??null};events.push(e);saveCurrent().catch(console.error);toast(`${type} logged`)}
function distanceNm(a,b){const rad=x=>x*Math.PI/180;const R=6371000;const dLat=rad(b.lat-a.lat),dLon=rad(b.lon-a.lon),x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(x))/1852}
function stats(){const a=samples.map(s=>s.sog).filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return {n:0,mean:null,std:null,median:null};const mean=a.reduce((x,y)=>x+y,0)/a.length;return {n:a.length,mean,std:Math.sqrt(a.reduce((sum,x)=>sum+(x-mean)**2,0)/a.length),median:a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2,min:a[0],max:a[a.length-1]}}
function derivedSamples(){
 const out=samples.map((s,i)=>({...s,t:Number.isFinite(s.t)?s.t:Date.now()+i*1000}));
 for(let i=0;i<out.length;i++){
  if(!Number.isFinite(out[i].course)&&i>0&&Number.isFinite(out[i].lat)&&Number.isFinite(out[i].lon)&&Number.isFinite(out[i-1].lat)&&Number.isFinite(out[i-1].lon))out[i].course=bearingDeg({lat:out[i-1].lat,lon:out[i-1].lon},{lat:out[i].lat,lon:out[i].lon});
  if(!Number.isFinite(out[i].sog)&&i>0){const dt=(out[i].t-out[i-1].t)/1000;if(dt>0&&dt<120&&Number.isFinite(out[i].lat)&&Number.isFinite(out[i].lon)&&Number.isFinite(out[i-1].lat)&&Number.isFinite(out[i-1].lon))out[i].sog=distanceNm(out[i-1],out[i])*3600/dt;}
 }
 return out;
}
function stdDev(vals){const a=vals.filter(Number.isFinite);if(a.length<2)return null;const m=a.reduce((x,y)=>x+y,0)/a.length;return Math.sqrt(a.reduce((z,x)=>z+(x-m)**2,0)/a.length)}
function analyzeManeuvers(data){
 const candidates=[];let last=-99;
 for(let i=3;i<data.length-3;i++){
  const a=data[i-3].course,b=data[i+3].course,dt=(data[i+3].t-data[i-3].t)/1000;
  if(!Number.isFinite(a)||!Number.isFinite(b)||dt<=0||dt>35)continue;
  const turn=Math.abs(angularDelta(b,a));if(turn<45||i-last<12)continue;
  let peak=i,maxRate=0;
  const lo=Math.max(1,i-5),hi=Math.min(data.length-2,i+5);
  for(let j=lo;j<=hi;j++){const d=(data[j].t-data[j-1].t)/1000;if(d>0){const r=Math.abs(angularDelta(data[j].course,data[j-1].course))/d;if(r>maxRate){maxRate=r;peak=j}}}
  const entry=data.slice(Math.max(0,peak-6),Math.max(1,peak-1)).map(x=>x.sog).filter(Number.isFinite);
  const center=data.slice(Math.max(0,peak-2),Math.min(data.length,peak+3)).map(x=>x.sog).filter(Number.isFinite);
  const exit=data.slice(Math.min(data.length-1,peak+2),Math.min(data.length,peak+7)).map(x=>x.sog).filter(Number.isFinite);
  if(entry.length<2||center.length<1||exit.length<2)continue;
  const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  const heel=data.slice(Math.max(0,peak-2),Math.min(data.length,peak+3)).map(x=>x.heel).filter(Number.isFinite);
  const pitch=data.slice(Math.max(0,peak-2),Math.min(data.length,peak+3)).map(x=>x.pitch).filter(Number.isFinite);
  const windRaw=Number(currentMeta().windDirectionInput),hasWind=currentMeta().windDirectionInput!=null&&Number.isFinite(windRaw);
  const avgCourse=circularMean(data.slice(Math.max(0,peak-5),Math.min(data.length,peak+6)).map(x=>x.course));
  let vmg=null,minVmg=null,vmgDistance=null,cwa=null;const mode=localStorage.getItem('saillabSailingMode')||'auto';
  if(hasWind&&avgCourse!=null){cwa=Math.abs(angularDelta(avgCourse,windRaw));const downwindTarget=(windRaw+180)%360;const target=mode==='downwind'?downwindTarget:mode==='upwind'?windRaw:(Math.cos(angularDelta(avgCourse,windRaw)*Math.PI/180)>0?windRaw:downwindTarget);const turnSlice=data.slice(Math.max(0,peak-5),Math.min(data.length,peak+6));const vmgs=turnSlice.map(x=>Number.isFinite(x.sog)&&Number.isFinite(x.course)?x.sog*Math.cos(angularDelta(x.course,target)*Math.PI/180):null);const usable=vmgs.filter(Number.isFinite);vmg=mean(usable);minVmg=usable.length?Math.min(...usable):null;vmgDistance=0;for(let k=1;k<turnSlice.length;k++){const dt=(turnSlice[k].t-turnSlice[k-1].t)/1000;if(dt>0&&dt<30&&Number.isFinite(vmgs[k])&&Number.isFinite(vmgs[k-1]))vmgDistance+=((vmgs[k]+vmgs[k-1])/2)*1852/3600*dt;}}
  const prev=data[Math.max(0,peak-2)],next=data[Math.min(data.length-1,peak+2)];
  const totalTurn=Math.abs(angularDelta(next.course,prev.course));if(!Number.isFinite(totalTurn))continue;
  const accelRates=[];for(let k=Math.max(1,peak-5);k<=Math.min(data.length-1,peak+5);k++){const dt=(data[k].t-data[k-1].t)/1000;if(dt>0&&dt<30&&Number.isFinite(data[k].sog)&&Number.isFinite(data[k-1].sog))accelRates.push({rate:(data[k].sog-data[k-1].sog)/dt,k});}
  const decelRates=accelRates.filter(x=>x.k<=peak).map(x=>x.rate),recoveryRates=accelRates.filter(x=>x.k>peak).map(x=>x.rate);
  const maxDecel=decelRates.length?Math.min(...decelRates):null,maxAccel=recoveryRates.length?Math.max(...recoveryRates):null;
  candidates.push({index:peak,type:totalTurn>120?'Gybe candidate':'Tack candidate',entry:mean(entry),min:Math.min(...center),exit:mean(exit),vmg,minVmg,vmgDistance,cwa,turn:totalTurn,rate:maxRate,heel:heel.length?Math.max(...heel.map(Math.abs)):null,pitch:pitch.length?mean(pitch):null,decel:maxDecel,accel:maxAccel});last=i;
 }
 return candidates;
}
function analyzeStraightLines(data){
 const lines=[];let start=0;
 const validCourse=i=>Number.isFinite(data[i]?.course)&&Number.isFinite(data[i]?.sog);
 const finish=end=>{
  const seg=data.slice(start,end+1);if(seg.length<5)return;
  const duration=(seg.at(-1).t-seg[0].t)/1000;if(duration<15)return;
  const courses=seg.map(x=>x.course).filter(Number.isFinite),speeds=seg.map(x=>x.sog).filter(Number.isFinite);
  if(courses.length<5||speeds.length<5)return;
  const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  const windRaw=Number(currentMeta().windDirectionInput),hasWind=currentMeta().windDirectionInput!=null&&Number.isFinite(windRaw);
  const avgCourse=circularMean(courses),mode=localStorage.getItem('saillabSailingMode')||'auto';
  let target=null;if(hasWind){const down=(windRaw+180)%360;target=mode==='downwind'?down:mode==='upwind'?windRaw:(Math.cos(angularDelta(avgCourse,windRaw)*Math.PI/180)>0?windRaw:down)}
  const vmgs=target==null?[]:seg.map(x=>Number.isFinite(x.sog)&&Number.isFinite(x.course)?x.sog*Math.cos(angularDelta(x.course,target)*Math.PI/180):null).filter(Number.isFinite);
  let dist=0;for(let i=1;i<seg.length;i++)if(Number.isFinite(seg[i].lat)&&Number.isFinite(seg[i].lon)&&Number.isFinite(seg[i-1].lat)&&Number.isFinite(seg[i-1].lon))dist+=distanceNm(seg[i-1],seg[i]);
  const heels=seg.map(x=>x.heel).filter(Number.isFinite),pitches=seg.map(x=>x.pitch).filter(Number.isFinite);
  const turnRates=[];const accel=[];for(let i=1;i<seg.length;i++){const dt=(seg[i].t-seg[i-1].t)/1000;if(dt>0&&dt<30){if(Number.isFinite(seg[i].course)&&Number.isFinite(seg[i-1].course))turnRates.push(Math.abs(angularDelta(seg[i].course,seg[i-1].course))/dt);if(Number.isFinite(seg[i].sog)&&Number.isFinite(seg[i-1].sog))accel.push((seg[i].sog-seg[i-1].sog)/dt)}}
  const first=seg[0].course,last=seg.at(-1).course;
  lines.push({index:start,startT:seg[0].t,endT:seg.at(-1).t,duration,distance:dist,side:hasWind?(Math.cos(angularDelta(avgCourse,windRaw)*Math.PI/180)>0?'Upwind':'Downwind'):(angularDelta(avgCourse,windRaw||0)>=0?'Course segment':'Course segment'),sog:mean(speeds),maxSog:Math.max(...speeds),vmg:vmgs.length?mean(vmgs):null,cwa:hasWind?Math.abs(angularDelta(avgCourse,windRaw)):null,heel:mean(heels),heelStability:stdDev(heels),pitch:mean(pitches),steeringStability:stdDev(turnRates),speedStability:stdDev(accel),courseChange:Math.abs(angularDelta(last,first))});
 };
 for(let i=1;i<data.length;i++){
  const prev=data[i-1],cur=data[i];
  const dt=(cur.t-prev.t)/1000;let split=false;
  if(!validCourse(i-1)||!validCourse(i)||dt<=0||dt>25)split=true;
  else if(Math.abs(angularDelta(cur.course,prev.course))>16)split=true;
  if(split){finish(i-1);start=i;}
 }
 finish(data.length-1);
 return lines;
}
function filteredByVmg(items,filter){if(filter==='all')return [...items];const ranked=items.filter(x=>Number.isFinite(x.vmg)).sort((a,b)=>b.vmg-a.vmg);const take=Math.max(1,Math.ceil(ranked.length*(filter==='top20'?.2:.5)));return ranked.slice(0,take).sort((a,b)=>a.index-b.index)}
function fillTable(id,rows,values,emptyText,colspan){const body=$(id);if(!body)return;body.innerHTML='';rows.forEach((row,i)=>{const tr=document.createElement('tr');values(row,i).forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.appendChild(td)});body.appendChild(tr)});if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=colspan;td.textContent=emptyText;tr.appendChild(td);body.appendChild(tr)}}
function renderAnalysis(){
 const has=samples.length>0;$('analysisEmpty').hidden=has;$('analysisContent').hidden=!has;if(!has)return;
 const data=derivedSamples(),valid=data.map(x=>x.sog).filter(Number.isFinite),s=stats();
 $('aCount').textContent=data.length;$('aMean').innerHTML=valid.length?(valid.reduce((a,b)=>a+b,0)/valid.length).toFixed(2)+'<small> kn</small>':'—';$('aStd').innerHTML=stdDev(valid.map((v,i)=>i? v-valid[i-1]:null))==null?'—':stdDev(valid.map((v,i)=>i? v-valid[i-1]:null)).toFixed(2)+'<small> kn/s Δ</small>';
 let d=0;for(let i=1;i<data.length;i++)if(Number.isFinite(data[i].lat)&&Number.isFinite(data[i].lon)&&Number.isFinite(data[i-1].lat)&&Number.isFinite(data[i-1].lon))d+=distanceNm(data[i-1],data[i]);$('distance').innerHTML=d.toFixed(2)+'<small> nm</small>';
 const course=data.map(x=>x.course).filter(Number.isFinite),heels=data.map(x=>x.heel).filter(Number.isFinite),pitches=data.map(x=>x.pitch).filter(Number.isFinite),wind=Number(currentMeta().windDirectionInput);
 $('aCog').textContent=course.length?Math.round(circularMean(course))+'°':'—';$('aCwa').textContent=course.length&&currentMeta().windDirectionInput!=null?Math.round(Math.abs(angularDelta(circularMean(course),wind)))+'°':'Set wind direction';$('aHeelStability').textContent=stdDev(heels)==null?'—':stdDev(heels).toFixed(2)+'°';$('aPitch').textContent=pitches.length?(pitches.reduce((a,b)=>a+b,0)/pitches.length).toFixed(2)+'°':'—';$('aSpeedStability').textContent=stdDev(data.slice(1).map((x,i)=>Number.isFinite(x.sog)&&Number.isFinite(data[i].sog)?x.sog-data[i].sog:null))?.toFixed(2)??'—';
 const allManeuvers=analyzeManeuvers(data),filter=$('maneuverFilter')?.value||'all';
 const tacks=filteredByVmg(allManeuvers.filter(m=>m.type==='Tack candidate'),filter),gybes=filteredByVmg(allManeuvers.filter(m=>m.type==='Gybe candidate'),filter),straight=filteredByVmg(analyzeStraightLines(data),filter);
 $('aManeuvers').textContent=allManeuvers.length;
 const maneuverVals=(m,i)=>[i+1,m.entry.toFixed(2),m.min.toFixed(2),m.exit.toFixed(2),m.vmg==null?'—':m.vmg.toFixed(2),m.minVmg==null?'—':m.minVmg.toFixed(2),m.vmgDistance==null?'—':m.vmgDistance.toFixed(1)+' m',m.turn.toFixed(0)+'°',m.rate.toFixed(1)+'°/s',m.heel==null?'—':m.heel.toFixed(1)+'°',m.decel==null?'—':m.decel.toFixed(2),m.accel==null?'—':m.accel.toFixed(2)];
 fillTable('straightRows',straight,(m,i)=>[i+1,m.side,fmtTime(m.duration*1000),m.distance.toFixed(2)+' nm',m.sog==null?'—':m.sog.toFixed(2)+' kn',m.maxSog.toFixed(2)+' kn',m.vmg==null?'Set wind':' '+m.vmg.toFixed(2)+' kn',m.cwa==null?'Set wind':m.cwa.toFixed(1)+'°',m.heel==null?'—':m.heel.toFixed(1)+'°',m.heelStability==null?'—':m.heelStability.toFixed(2)+'°',m.pitch==null?'—':m.pitch.toFixed(1)+'°',m.steeringStability==null?'—':m.steeringStability.toFixed(2)+'°/s',m.speedStability==null?'—':m.speedStability.toFixed(3)+' kn/s'],'No straight-line segments meet the minimum duration/sample requirements yet.',13);
 fillTable('tackRows',tacks,maneuverVals,'No tack candidates detected yet. Record a steady GPS track with sufficient sampling.',12);
 fillTable('gybeRows',gybes,maneuverVals,'No gybe candidates detected yet. Record a steady GPS track with sufficient sampling.',12);
 const body=$('sampleRows');body.innerHTML='';data.slice(-30).reverse().forEach(x=>{const tr=document.createElement('tr');[new Date(x.t).toLocaleTimeString('en-GB'),x.sog==null?'—':x.sog.toFixed(2),x.course==null?'—':Math.round(x.course)+'°',x.heel==null?'—':Math.round(x.heel)+'°',x.pitch==null?'—':(Math.round(x.pitch/0.5)*0.5).toFixed(1)+'°',x.accuracy==null?'—':Math.round(x.accuracy)].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.appendChild(td)});body.appendChild(tr)});drawChart();
}
function drawChart(){const c=$('speedChart');if(!c||!samples.length)return;const rect=c.getBoundingClientRect(),ratio=window.devicePixelRatio||1;c.width=Math.max(300,rect.width*ratio);c.height=180*ratio;const ctx=c.getContext('2d');ctx.scale(ratio,ratio);const w=c.width/ratio,h=180;ctx.clearRect(0,0,w,h);const chartData=derivedSamples();const vals=chartData.map(s=>s.sog).filter(Number.isFinite);if(!vals.length){ctx.fillStyle='#9eb0c0';ctx.fillText('No valid speed samples',12,30);return}const max=Math.max(1,...vals)*1.1;ctx.strokeStyle='#294054';ctx.lineWidth=1;for(let i=0;i<4;i++){const y=12+(h-28)*i/3;ctx.beginPath();ctx.moveTo(34,y);ctx.lineTo(w-8,y);ctx.stroke();ctx.fillStyle='#9eb0c0';ctx.font='10px sans-serif';ctx.fillText((max*(1-i/3)).toFixed(1),3,y+3)}ctx.strokeStyle='#54e0c0';ctx.lineWidth=2;ctx.beginPath();let n=0;const step=Math.max(1,Math.ceil(samples.length/(w-42)));for(let i=0;i<chartData.length;i+=step){const v=chartData[i].sog;if(!Number.isFinite(v))continue;const x=34+(w-44)*(i/Math.max(1,chartData.length-1)),y=h-16-(h-32)*(v/max);if(!n++)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.stroke()}
async function renderSessions(){const all=(await dbAll()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));const list=$('sessionsList');list.innerHTML='';if(!all.length){list.innerHTML='<p class="muted">No saved sessions yet.</p>';return}for(const s of all){const row=document.createElement('div');row.className='session-row';const info=document.createElement('div');const title=document.createElement('div');title.className='session-title';title.textContent=s.name||'Unnamed session';const meta=document.createElement('div');meta.className='session-meta';meta.textContent=`${new Date(s.createdAt).toLocaleString('en-GB')} · ${(s.samples||[]).length} samples · ${s.status==='finished'?'finished':s.status==='imported'?'GPX imported':'incomplete'}`;info.append(title,meta);const actions=document.createElement('div');actions.className='session-actions';const load=document.createElement('button');load.textContent='Open';load.onclick=()=>loadSession(s.id);const exp=document.createElement('button');exp.textContent='JSON';exp.onclick=()=>downloadJson(s);const del=document.createElement('button');del.textContent='Delete';del.onclick=async()=>{if(confirm('Delete this session from this device?')){await dbDelete(s.id);if(current?.id===s.id){current=null;samples=[];events=[];updateControls()}renderSessions();toast('Session deleted')}};actions.append(load,exp,del);row.append(info,actions);list.append(row)}}
async function loadSession(id){const s=(await dbAll()).find(x=>x.id===id);if(!s)return;if(current&&['recording','paused'].includes(current.status)&&!confirm('Load another session? The active session will remain in the history.'))return;current=s;samples=[...(s.samples||[])];events=[...(s.events||[])];elapsedBeforePause=s.durationMs||0;sessionStartMs=null;paused=false;for(const [key,id2] of [['name','sessionName'],...META_FIELDS.slice(1).map(id=>[id,id])]){const el=$(id2);if(el)el.value=s[key]??'';}dockTunePhotos=[...(s.dockTunePhotos||[])];renderDockTunePhotos();updateControls();updateStats();renderAnalysis();showView('analysis');toast('Session loaded')}
function download(name,content,type){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500)}
function safeName(s){return (s||'saillab').replace(/[^a-z0-9-_]+/gi,'_').slice(0,50)}
function downloadJson(s){download(`${safeName(s.name)}.json`,JSON.stringify(s,null,2),'application/json')}
function exportJson(){if(!current){toast('No session selected');return}downloadJson({...current,...currentMeta(),samples,events,durationMs:elapsed()})}
function exportCsv(){if(!current){toast('No session selected');return}const rows=[['timestamp','latitude','longitude','altitude_m','accuracy_m','sog_kn','course_gps_deg'],...samples.map(s=>[new Date(s.t).toISOString(),s.lat,s.lon,s.alt,s.accuracy,s.sog,s.course])];const csv=rows.map(r=>r.map(v=>v==null?'':String(v).replaceAll('"','""')).map(v=>/[,"\n]/.test(v)?`"${v}"`:v).join(',')).join('\r\n');download(`${safeName(current.name)}.csv`,'\ufeff'+csv,'text/csv;charset=utf-8')}
function showView(name){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));document.querySelectorAll('.nav-item').forEach(v=>v.classList.toggle('active',v.dataset.view===name));if(name==='analysis')renderAnalysis();if(name==='settings'){renderSessions();if($('settingsGpsToggle'))$('settingsGpsToggle').textContent=watchId!==null?'Disable GPS':'Enable GPS';}if(name==='cockpit'){setTimeout(()=>{dashMap?.invalidateSize();drawHeelTrimChart()},80)}}
function markTack(type){if(!current){toast('Start a session first');return}if(activeTack){activeTack.endedAt=new Date().toISOString();activeTack.durationMs=activeTack.samples.length>1?activeTack.samples.at(-1).t-activeTack.samples[0].t:0;tackSegments[activeTack.type].push(activeTack);activeTack=null}activeTack={type,startAt:new Date().toISOString(),samples:[],courseSamples:[],distance:0,last:lastFix?{lat:lastFix.coords.latitude,lon:lastFix.coords.longitude,t:Date.now(),course:lastFix.coords.heading==null?null:lastFix.coords.heading}:null};events.push({id:uid(),type:type==='port'?'Port tack start':'Starboard tack start',timestamp:new Date().toISOString(),lat:lastFix?.coords.latitude??null,lon:lastFix?.coords.longitude??null});$('portCount').textContent=tackSegments.port.length+(activeTack?.type==='port'?1:0);$('starboardCount').textContent=tackSegments.starboard.length+(activeTack?.type==='starboard'?1:0);toast(type==='port'?'Port tack marked':'Starboard tack marked')}
function updateWind(){const p=tackSegments.port.length+(activeTack?.type==='port'?1:0),s=tackSegments.starboard.length+(activeTack?.type==='starboard'?1:0);$('portCount').textContent=p;$('starboardCount').textContent=s;$('windResult').textContent=p&&s?'Both tacks have been marked. Wind direction is estimated from GPS course averages when usable legs are recorded on each tack.':'Not enough data to estimate wind direction. Record and mark at least one steady leg on each tack.'}
function importGpx(text){const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw new Error('Invalid GPX file');const pts=[...doc.getElementsByTagNameNS('*','trkpt'),...doc.getElementsByTagNameNS('*','rtept')];if(!pts.length)throw new Error('No track points found');const imported=[];for(const p of pts){const lat=Number(p.getAttribute('lat')),lon=Number(p.getAttribute('lon'));if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;const time=p.getElementsByTagNameNS('*','time')[0]?.textContent;const ele=p.getElementsByTagNameNS('*','ele')[0]?.textContent;imported.push({t:time&&Number.isFinite(Date.parse(time))?Date.parse(time):null,lat,lon,alt:ele!=null&&ele.trim()!==''&&Number.isFinite(Number(ele))?Number(ele):null,accuracy:null,sog:null,course:null,heel:null,pitch:null})}if(!imported.length)throw new Error('No valid GPS points');const s={id:uid(),createdAt:new Date().toISOString(),name:'Imported GPX track',boat:'',crew:'',location:'',opponents:'',onboardFeeling:'',wind:null,waves:null,windDirectionInput:null,currentDirection:null,gustiness:null,waveState:null,weatherNotes:'Imported from GPX. Timestamp/altitude are null where missing.',status:'imported',durationMs:0,samples:imported,events:[],gpx:true};return dbPut(s).then(()=>s)}
const themeSelect=null;
function applyTheme(theme){const allowed=['dark','light','blue','purple','yellow'];const value=allowed.includes(theme)?theme:'blue';document.body.dataset.theme=value;document.documentElement.style.colorScheme=value==='light'?'light':'dark';if(themeSelect)themeSelect.value=value;localStorage.setItem('saillabTheme',value)}
if(themeSelect){themeSelect.value=localStorage.getItem('saillabTheme')||'blue';applyTheme(themeSelect.value);themeSelect.addEventListener('change',()=>{applyTheme(themeSelect.value);toast(`${themeSelect.options[themeSelect.selectedIndex].text} theme applied`)})}else applyTheme(localStorage.getItem('saillabTheme')||'blue');
$('sensorBtn').onclick=()=>{if(motion.enabled){window.removeEventListener('deviceorientation',onOrientation,true);motion.enabled=false;motion.heel=null;motion.pitch=null;updateMotionDisplay();$('sensorBtn').textContent='Enable IMU / motion sensors';toast('IMU / motion sensors disabled')}else enableMotion()};
const settingsTheme=$('settingsTheme');if(settingsTheme){settingsTheme.value=localStorage.getItem('saillabTheme')||'blue';settingsTheme.addEventListener('change',()=>{applyTheme(settingsTheme.value);if(themeSelect)themeSelect.value=settingsTheme.value})}
const sailingMode=$('sailingMode');if(sailingMode){sailingMode.value=localStorage.getItem('saillabSailingMode')||'auto';sailingMode.addEventListener('change',()=>{localStorage.setItem('saillabSailingMode',sailingMode.value);renderAnalysis()})}
const settingsGps=$('settingsGpsToggle');if(settingsGps){settingsGps.onclick=()=>{if(watchId!==null){stopGps();settingsGps.textContent='Enable GPS';$('gpsBadge').className='status';$('gpsBadge').innerHTML='<span class="dot"></span> GPS inactive';toast('GPS stopped')}else{requestGps();settingsGps.textContent='Disable GPS'}}}

$('zeroHeelBtn').onclick=()=>setZero('heel');
$('zeroPitchBtn').onclick=()=>setZero('pitch');
$('lockScreenBtn').onclick=lockScreen;
$('wakeLockBtn').onclick=toggleWakeLock;
$('widgetSelect').onchange=loadWidgetForm;
if($('maneuverFilter'))$('maneuverFilter').onchange=renderAnalysis;
if($('dockTunePhotosInput'))$('dockTunePhotosInput').addEventListener('change',e=>{handleDockPhotos(e.target.files||[]);e.target.value=''});
['widgetWidth','widgetFont','widgetBg','widgetColor'].forEach(id=>$(id).addEventListener('change',saveSelectedWidget));
$('widgetUp').onclick=()=>moveWidget(-1);
$('widgetDown').onclick=()=>moveWidget(1);
$('widgetHide').onclick=()=>{const id=$('widgetSelect').value;widgetPrefs[id]={...(widgetPrefs[id]||{}),hidden:!(widgetPrefs[id]||{}).hidden};localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyWidgetPrefs()};
$('widgetReset').onclick=resetWidgetPrefs;
$('screenLockOverlay').addEventListener('pointerdown',e=>{if(e.target.id!=='unlockButton')startUnlockHold()});
$('screenLockOverlay').addEventListener('pointerup',cancelUnlockHold);
$('screenLockOverlay').addEventListener('pointercancel',cancelUnlockHold);
$('screenLockOverlay').addEventListener('pointerleave',cancelUnlockHold);

$('startBtn').onclick=start;$('pauseBtn').onclick=pause;$('resumeBtn').onclick=resume;$('stopBtn').onclick=finish;$('refreshGps').onclick=requestGps;
document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>showView(b.dataset.view));
document.querySelectorAll('[data-event]').forEach(b=>b.onclick=()=>eventRecord(b.dataset.event));
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
 $('lineDistance').innerHTML=dist==null?'—<small> m</small>':`${Math.round(Math.abs(dist))}<small> m</small>`;$('timeToLine').textContent=seconds==null?'—':fmtClock(seconds);const gun=remainingGunSeconds();$('gunCountdown').textContent=gun==null?fmtClock(Number($('gunSeconds')?.value||0)):fmtClock(gun);if(gun!=null){$('gunStatus').textContent=gun<=0?'GUN TIME':'Countdown running'}else $('gunStatus').textContent='Countdown not running';let burn=gun!=null&&seconds!=null?gun-seconds:null;$('timeToBurn').textContent=burn==null?'—':fmtClock(burn);$('burnHint').textContent=burn==null?'Set gun countdown and get a GPS fix':burn>=0?'Positive = time to kill / slow down':'Negative = estimated late';if($('dashBurn')){$('dashBurn').textContent=burn==null?'—':fmtClock(burn);$('dashTimeToLine').textContent=seconds==null?'—':fmtClock(seconds)}
 const sq=$('lineSquare'),sqHint=$('lineSquareHint');
 if(sq&&raceMarks.committee&&raceMarks.pin){const wind=windEstimate();if(wind){const lineBearing=bearingDeg(raceMarks.committee,raceMarks.pin);let angle=Math.abs(angularDelta(lineBearing,wind.direction));if(angle>90)angle=180-angle;const deviation=90-angle;sq.textContent=deviation<0.5?'Square':`±${deviation.toFixed(1)}°`;if(sqHint)sqHint.textContent=deviation<0.5?'Line is square to estimated wind':`${deviation.toFixed(1)}° off square · based on estimated wind`}else{sq.textContent='—';if(sqHint)sqHint.textContent='Record both tacks to estimate wind direction'}}else if(sq){sq.textContent='—';if(sqHint)sqHint.textContent='Ping both endpoints first'}
}
function finishGunCountdown(){if(gunTimer)clearInterval(gunTimer);gunTimer=null;$('gunCountdown').textContent='00:00';$('gunStatus').textContent='START — switching to cockpit';toast('Start! Switching to cockpit');if(!raceAutoSwitched){raceAutoSwitched=true;setTimeout(()=>showView('cockpit'),900)}}
function ensureGunTimer(){if(gunTimer)clearInterval(gunTimer);gunTimer=setInterval(()=>{updateRaceMetrics();if(remainingGunSeconds()<=0){gunDeadline=null;finishGunCountdown()}},100)}
function startGunCountdown(){const sec=Math.max(0,Number($('gunSeconds').value)||0);if(sec<=0){toast('Set a countdown greater than zero');return}gunDeadline=Date.now()+sec*1000;localStorage.setItem('saillabGunSeconds',String(sec));raceAutoSwitched=false;ensureGunTimer();updateRaceMetrics();toast('Start countdown running')}
function syncGunToMinute(){const now=Date.now();if(gunDeadline!=null){const remaining=Math.max(0,Math.ceil((gunDeadline-now)/1000));const snapped=Math.floor(remaining/60)*60;if(snapped<=0){gunDeadline=now;updateRaceMetrics();finishGunCountdown();return}gunDeadline=now+snapped*1000;$('gunSeconds').value=String(snapped);localStorage.setItem('saillabGunSeconds',String(snapped));if(!gunTimer)ensureGunTimer();updateRaceMetrics();toast(`Countdown synced to ${fmtClock(snapped)}`);return}const selected=Math.max(0,Number($('gunSeconds').value)||0);const snapped=Math.floor(selected/60)*60;$('gunSeconds').value=String(snapped);localStorage.setItem('saillabGunSeconds',String(snapped));updateRaceMetrics();toast(`Set to whole minute: ${fmtClock(snapped)}`)}
function adjustGunMinutes(delta){const input=$('gunSeconds');const next=Math.max(0,(Number(input.value)||0)+delta*60);input.value=String(next);localStorage.setItem('saillabGunSeconds',String(next));if(gunDeadline!=null){gunDeadline+=delta*60000;if(gunTimer==null&&remainingGunSeconds()>0){gunTimer=setInterval(()=>{updateRaceMetrics();if(remainingGunSeconds()<=0){clearInterval(gunTimer);gunTimer=null;$('gunCountdown').textContent='00:00';$('gunStatus').textContent='START — switching to cockpit';toast('Start! Switching to cockpit');if(!raceAutoSwitched){raceAutoSwitched=true;setTimeout(()=>showView('cockpit'),900)}}},100)}}updateRaceMetrics()}
function resetGunCountdown(){if(gunTimer)clearInterval(gunTimer);gunTimer=null;gunDeadline=null;raceAutoSwitched=false;updateRaceMetrics()}
function initMap(containerId,which){if(typeof L==='undefined')return null;const el=$(containerId);if(!el)return null;const map=L.map(el,{zoomControl:true,attributionControl:true}).setView([41.0,9.0],10);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);const layers={};layers.boat=L.circleMarker([41,9],{radius:7,color:'#54e0c0',fillColor:'#54e0c0',fillOpacity:1,weight:2}).bindTooltip('Your boat');layers.committee=L.circleMarker([41,9],{radius:7,color:'#a78bfa',fillColor:'#a78bfa',fillOpacity:1,weight:2}).bindTooltip('Committee boat');layers.pin=L.circleMarker([41,9],{radius:7,color:'#ffb454',fillColor:'#ffb454',fillOpacity:1,weight:2}).bindTooltip('Pin');layers.line=L.polyline([[41,9],[41,9]],{color:'#f1f6fa',weight:3,dashArray:'7 6'});Object.values(layers).forEach(l=>l.addTo(map));if(which==='race'){raceMap=map;raceLayers=layers}else{dashMap=map;dashLayers=layers}refreshMap(which);return map}
function refreshMap(which){const map=which==='race'?raceMap:dashMap,layers=which==='race'?raceLayers:dashLayers;if(!map||!layers)return;const p=currentPoint();if(p){layers.boat.setLatLng([p.lat,p.lon]);layers.boat.setStyle({opacity:1,fillOpacity:1})}else layers.boat.setStyle({opacity:0,fillOpacity:0});for(const k of ['committee','pin']){const v=raceMarks[k];if(v){layers[k].setLatLng([v.lat,v.lon]);layers[k].setStyle({opacity:1,fillOpacity:1})}else layers[k].setStyle({opacity:0,fillOpacity:0})}if(raceMarks.committee&&raceMarks.pin)layers.line.setLatLngs([[raceMarks.committee.lat,raceMarks.committee.lon],[raceMarks.pin.lat,raceMarks.pin.lon]]);else layers.line.setLatLngs([]);const pts=[p,raceMarks.committee,raceMarks.pin].filter(Boolean).map(x=>[x.lat,x.lon]);if(pts.length&&map._saillabFirstFit!==true){map.fitBounds(pts,{padding:[25,25],maxZoom:16});map._saillabFirstFit=true}}
function refreshMaps(){refreshMap('race');refreshMap('dash')}
function avgWindow(history,seconds){const now=Date.now(),values=history.filter(x=>now-x.t<=seconds*1000).map(x=>x.value).filter(Number.isFinite);return values.length?values.reduce((a,b)=>a+b,0)/values.length:null}
function renderCockpit(){
 const heel=correctedMotion('heel');
 if($('heel'))$('heel').textContent=heel==null?'—':Math.round(heel);
 const h5=avgWindow(heelHistory,5),h20=avgWindow(heelHistory,20);
 if($('heelAvg5'))$('heelAvg5').textContent=h5==null?'—°':`${h5.toFixed(1)}°`;
 if($('heelAvg20'))$('heelAvg20').textContent=h20==null?'—°':`${h20.toFixed(1)}°`;
 if($('heelBubble')){const value=Math.max(-16,Math.min(16,heel??0));$('heelBubble').style.left=`${((value+16)/32)*100}%`; $('heelBubble').classList.toggle('unknown',heel==null)}
 const trim=correctedMotion('pitch'),trim5=avgWindow(pitchHistory,5),trim30=avgWindow(pitchHistory,30);
 if($('trimNow'))$('trimNow').textContent=trim==null?'—':trim.toFixed(1);
 if($('trimAvg5'))$('trimAvg5').textContent=trim5==null?'—°':`${trim5.toFixed(1)}°`;
 if($('trimAvg30'))$('trimAvg30').textContent=trim30==null?'—°':`${trim30.toFixed(1)}°`;
 if($('trimCount'))$('trimCount').textContent=motion.enabled?'Motion sensor pitch / longitudinal trim':'Enable motion sensors to read trim';
 if($('sog')&&lastFix?.coords.speed!=null)$('sog').textContent=(lastFix.coords.speed*KNOTS_PER_MS).toFixed(1);
 if($('course'))$('course').textContent=lastFix?.coords.heading==null?'—':Math.round(lastFix.coords.heading);
 updateWind();updateRaceMetrics();refreshMaps();
}
function dashboardConfig(){applyWidgetPrefs();const editor=$('dashboardEditor');if(editor)editor.hidden=true}
function saveDashOrder(){[...$('dashboardGrid').querySelectorAll('[data-widget]')].forEach((el,i)=>{const id=el.dataset.widget;widgetPrefs[id]={...(widgetPrefs[id]||{}),order:i}});localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyWidgetPrefs()}

function updateWind(){
 const portCount=tackSegments.port.length+(activeTack?.type==='port'?1:0),starCount=tackSegments.starboard.length+(activeTack?.type==='starboard'?1:0);
 $('portCount').textContent=portCount;$('starboardCount').textContent=starCount;
 if($('cockpitPortCount'))$('cockpitPortCount').textContent=portCount;if($('cockpitStarboardCount'))$('cockpitStarboardCount').textContent=starCount;
 const p=meanForSegments(tackSegments.port),s=meanForSegments(tackSegments.starboard);
 $('portMean').textContent=`Average course ${p==null?'—':Math.round(p)+'°'}`;$('starboardMean').textContent=`Average course ${s==null?'—':Math.round(s)+'°'}`;
 const courseNow=lastFix?.coords.heading;if($('dashWindHeading'))$('dashWindHeading').textContent=courseNow==null?'—°':`${Math.round(courseNow)}°`;
 const est=windEstimate();
 if(!est){$('windDirection').textContent='—';$('leftShift').textContent='—';$('rightShift').textContent='—';$('windBaselineLabel').textContent=windBaseline==null?'Baseline not set':`Baseline ${Math.round(windBaseline)}°`;$('windResult').textContent='Need at least one completed, usable upwind leg on both port and starboard tack. Record several steady GPS course samples per leg.';if($('dashWindShift')){$('dashWindShift').textContent='—';$('dashWindLabel').textContent='NO SHIFT DATA';$('dashTrueWindDirection').textContent='—°'}renderWindShiftLeds(null);return}
 $('windDirection').textContent=String(Math.round(est.direction)).padStart(3,'0');$('windNeedle').style.transform=`rotate(${est.direction}deg)`;$('windBaselineLabel').textContent=windBaseline==null?'Baseline not set':`Baseline ${Math.round(windBaseline)}°`;
 const delta=est.delta;$('leftShift').textContent=delta==null?'—':`${delta<0?Math.abs(delta).toFixed(0)+'°':'0°'}`;$('rightShift').textContent=delta==null?'—':`${delta>0?delta.toFixed(0)+'°':'0°'}`;
 $('windResult').textContent=delta==null?'Estimated direction available. Set a baseline in the Wind Shifts page to show subsequent left/right shifts.':delta>0?`RIGHT SHIFT: estimated wind direction has moved ${delta.toFixed(1)}° clockwise from baseline.`:delta<0?`LEFT SHIFT: estimated wind direction has moved ${Math.abs(delta).toFixed(1)}° counter-clockwise from baseline.`:'Wind direction is unchanged from baseline.';
 if($('dashWindShift')){$('dashWindShift').textContent=delta==null?'—':`${Math.abs(delta).toFixed(0)}°`;$('dashWindLabel').textContent=delta==null?'SET BASELINE':delta>0?'RIGHT SHIFT':delta<0?'LEFT SHIFT':'NO SHIFT';$('dashTrueWindDirection').textContent=`${Math.round(est.direction)}°`}
 renderWindShiftLeds(delta);
}
// Replace the older marker implementation with a segment-aware tack recorder.
function markTack(type){if(!current){toast('Start a session before marking a tack');return}if(activeTack){activeTack.endedAt=new Date().toISOString();activeTack.durationMs=activeTack.samples.length>1?activeTack.samples.at(-1).t-activeTack.samples[0].t:0;activeTack.meanCourse=circularMean(activeTack.courseSamples);if(activeTack.samples.length>=3&&activeTack.courseSamples.length>=2)tackSegments[activeTack.type].push(activeTack);persistWindLegMeans();activeTack=null}activeTack={type,startAt:new Date().toISOString(),samples:[],courseSamples:[],distance:0,last:lastFix?{lat:lastFix.coords.latitude,lon:lastFix.coords.longitude,t:Date.now(),course:lastFix.coords.heading==null?null:lastFix.coords.heading}:null};if(lastFix?.coords.heading!=null)activeTack.courseSamples.push(lastFix.coords.heading);events.push({id:uid(),type:type==='port'?'Port tack start':'Starboard tack start',timestamp:new Date().toISOString(),lat:lastFix?.coords.latitude??null,lon:lastFix?.coords.longitude??null});updateWind();toast(type==='port'?'Port tack leg started':'Starboard tack leg started')}

function applyDashboardLayout(layout){
 const grid=$('dashboardGrid');if(!grid)return;
 const chosen=layout||localStorage.getItem('saillabDashboardLayout')||'race';
 grid.dataset.layout=chosen;document.querySelectorAll('[data-layout]').forEach(b=>b.classList.toggle('active',b.dataset.layout===chosen));
 if($('dashboardLayout'))$('dashboardLayout').value=chosen;
 localStorage.setItem('saillabDashboardLayout',chosen);
 const defaultOrder={race:['live-sog','live-course','live-heel','trim','wind-detail'],balanced:['live-sog','live-course','wind-detail','live-heel','trim'],minimal:['live-sog','live-course','live-heel','wind-detail','trim'],big:['live-sog','live-course','live-heel','trim','wind-detail']}[chosen]||['live-sog','live-course','live-heel','trim','wind-detail'];
 const cards=[...grid.querySelectorAll('[data-widget]')];
 if(layout||!cards.some(card=>widgetPrefs[card.dataset.widget]?.order!==undefined)){defaultOrder.forEach((id,i)=>{const card=grid.querySelector(`[data-widget="${id}"]`);if(card){grid.appendChild(card);widgetPrefs[id]={...(widgetPrefs[id]||{}),order:i}}});localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));}
 else cards.sort((a,b)=>(widgetPrefs[a.dataset.widget]?.order??100)-(widgetPrefs[b.dataset.widget]?.order??100)).forEach(card=>grid.appendChild(card));
 grid.querySelectorAll('[data-widget]').forEach(card=>{const id=card.dataset.widget,p=widgetPrefs[id]||{};let full=chosen==='big'||(chosen==='race'&&id==='wind-detail')||(chosen==='balanced'&&id==='wind-detail')||(chosen==='minimal'&&id==='wind-detail');if(p.width)full=p.width==='full';card.classList.toggle('widget-full',full);card.classList.toggle('dash-wide',full);card.classList.toggle('widget-hidden',p.hidden===true||(chosen==='minimal'&&id==='trim'));});
}
function setupLayoutControls(){document.querySelectorAll('[data-layout]').forEach(b=>b.addEventListener('click',()=>applyDashboardLayout(b.dataset.layout)));if($('dashboardLayout'))$('dashboardLayout').addEventListener('change',e=>applyDashboardLayout(e.target.value));}

function initRaceFeature(){updateRaceEndpoints();$('gunSeconds').value=localStorage.getItem('saillabGunSeconds')||'300';$('pingCommittee').onclick=()=>pingEndpoint('committee');$('pingPin').onclick=()=>pingEndpoint('pin');$('gunStart').onclick=startGunCountdown;$('gunSync').onclick=syncGunToMinute;$('gunMinusMinute').onclick=()=>adjustGunMinutes(-1);$('gunPlusMinute').onclick=()=>adjustGunMinutes(1);$('gunReset').onclick=resetGunCountdown;$('centerRaceMap').onclick=()=>{if(raceMap){const pts=[currentPoint(),raceMarks.committee,raceMarks.pin].filter(Boolean).map(x=>[x.lat,x.lon]);if(pts.length)raceMap.fitBounds(pts,{padding:[25,25],maxZoom:16})}};$('dashboardRaceBtn')&&($('dashboardRaceBtn').onclick=()=>showView('race'));$('widgetSelect').onchange=loadWidgetForm;$('widgetWidth').onchange=saveSelectedWidget;$('widgetFont').onchange=saveSelectedWidget;$('widgetBg').onchange=saveSelectedWidget;$('widgetColor').onchange=saveSelectedWidget;$('widgetUp').onclick=()=>moveWidget(-1);$('widgetDown').onclick=()=>moveWidget(1);$('widgetHide').onclick=()=>{const id=$('widgetSelect').value;widgetPrefs[id]={...(widgetPrefs[id]||{}),hidden:!(widgetPrefs[id]?.hidden)};localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyWidgetPrefs()};$('widgetReset').onclick=()=>{widgetPrefs={};localStorage.removeItem('saillabWidgetPrefs');applyWidgetPrefs();applyDashboardLayout('race');toast('Dashboard reset')};$('logTrim').onclick=logTrim;$('setWindBaseline').onclick=()=>{const w=windEstimate();if(!w){toast('Record both tacks first');return}windBaseline=w.direction;localStorage.setItem('saillabWindBaseline',JSON.stringify(windBaseline));updateWind();renderCockpit();toast('Wind baseline set')};$('resetWindData').onclick=()=>{if(!confirm('Clear saved port/starboard legs and the wind-shift baseline?'))return;windBaseline=null;tackSegments={port:[],starboard:[]};localStorage.removeItem('saillabWindBaseline');localStorage.removeItem('saillabWindLegMeans');updateWind();renderCockpit();toast('Wind legs and baseline cleared')};
 $('portTack').onclick=()=>{markTack('port')};$('starboardTack').onclick=()=>{markTack('starboard')};$('cockpitPortTack').onclick=()=>{markTack('port')};$('cockpitStarboardTack').onclick=()=>{markTack('starboard')};
 dashboardConfig();setupLayoutControls();setupEditorControls();applyDashboardLayout();
}
const originalShowView=showView;
showView=function(name){originalShowView(name);if(name==='race'){if(!raceMap&&typeof L!=='undefined')initMap('raceMap','race');setTimeout(()=>raceMap?.invalidateSize(),80);refreshMap('race')}if(name==='cockpit'){if(!dashMap&&typeof L!=='undefined')initMap('dashboardMap','dash');setTimeout(()=>dashMap?.invalidateSize(),80);refreshMap('dash');renderCockpit()}if(name==='wind'){setTimeout(()=>{},0);return}};
window.addEventListener('resize',()=>{if($('view-cockpit')?.classList.contains('active')){dashMap?.invalidateSize();renderCockpit()}if($('view-race')?.classList.contains('active'))raceMap?.invalidateSize()});
const previousRequestGps=requestGps;
requestGps=function(){previousRequestGps();if($('settingsGpsToggle'))$('settingsGpsToggle').textContent='Disable GPS';setTimeout(()=>{updateRaceMetrics();renderCockpit()},300)};
const previousUpdateStats=updateStats;
updateStats=function(){previousUpdateStats();renderCockpit()};
const previousOrientationDisplay=updateMotionDisplay;
updateMotionDisplay=function(){previousOrientationDisplay();renderCockpit()};
const previousApplyPrefs=applyWidgetPrefs;
applyWidgetPrefs=function(){previousApplyPrefs();applyDashboardLayout();renderCockpit()};
initRaceFeature();if(typeof L!=='undefined')initMap('dashboardMap','dash');updateWind();updateRaceMetrics();renderCockpit();setTimeout(()=>dashMap?.invalidateSize(),100);
