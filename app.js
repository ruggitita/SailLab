/* SailLab — local data storage, no server upload. GPS access depends on browser permissions and limitations. */
const $ = id => document.getElementById(id);
const DB_NAME='SailLabDB', DB_VERSION=1, STORE='sessions';
let db, watchId=null, current=null, timerId=null, lastFix=null, lastSampleAt=null, sessionStartMs=null, elapsedBeforePause=0, paused=false, samples=[], events=[], tackSegments={port:[],starboard:[]}, activeTack=null, toastTimer, motion={heel:null,pitch:null,enabled:false};
let dockTunePhotos=[];
let heelHistory=[],pitchHistory=[],sogHistory=[],courseHistory=[],autoWindTimer=null,autoWindState={direction:null,portCourse:null,starboardCourse:null,quality:'Waiting for stable GPS course legs',updatedAt:null,attemptedAt:null};
let savedFlags=JSON.parse(localStorage.getItem('saillabFlags')||'[]');
let flagPhotoData=null;
let zeroOffsets=JSON.parse(localStorage.getItem('saillabZeroOffsets')||'{"heel":0,"pitch":0}');
let widgetPrefs=JSON.parse(localStorage.getItem('saillabWidgetPrefs')||'{}');
let customWidgetDefs=JSON.parse(localStorage.getItem('saillabCustomWidgets')||'[]');
let activePointerEdit=null;
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
function widgetDecimals(id,fallback=1){const d=widgetPrefs[id]?.decimals;return Number.isInteger(d)?Math.max(0,Math.min(3,d)):fallback}
function widgetNumber(id,value,fallback=1){return Number.isFinite(value)?value.toFixed(widgetDecimals(id,fallback)):'—'}
function updateExtraBarValues(){
 document.querySelectorAll('#dashboardGrid [data-widget]').forEach(card=>{const bar=card.querySelector('.custom-extra-bar');if(!bar)return;const id=card.dataset.widget;let value=null,max=1;
  if(id==='live-sog'){value=lastFix?.coords.speed==null?null:lastFix.coords.speed*KNOTS_PER_MS;max=20}
  else if(id==='live-course'){value=lastFix?.coords.heading??null;max=360}
  else if(id==='live-heel'){value=correctedMotion('heel');max=16;value=value==null?null:Math.abs(value)}
  else if(id==='trim'){value=correctedMotion('pitch');max=4;value=value==null?null:Math.abs(value)}
  else if(id==='wind-detail'){value=autoWindState.direction==null?null:Math.abs(angularDelta(autoWindState.direction,windBaseline??autoWindState.direction));max=30}
  bar.style.setProperty('--bar-progress',`${value==null?0:Math.max(0,Math.min(100,value/max*100))}%`);bar.classList.toggle('unknown',value==null);
 });
}
function updateMotionDisplay(){
  const heel=correctedMotion('heel'), pitch=correctedMotion('pitch');
  if($('heel'))$('heel').textContent = widgetNumber('live-heel',heel,0);
  if($('pitch'))$('pitch').textContent = pitch==null ? '—' : `${(Math.round(pitch / 0.5) * 0.5).toFixed(1)}`;
  $('zeroStatus').textContent=`Zero offsets — HEEL: ${(Number(zeroOffsets.heel)||0).toFixed(1)}°, PITCH: ${(Number(zeroOffsets.pitch)||0).toFixed(1)}°.`;updateExtraBarValues();
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
    if(p.valueSize!==undefined)card.style.setProperty('--custom-value-size',`${Number(p.valueSize)}px`);else card.style.removeProperty('--custom-value-size');
    if(p.labelSize!==undefined)card.style.setProperty('--custom-label-size',`${Number(p.labelSize)}px`);else card.style.removeProperty('--custom-label-size');
    if(p.secondarySize!==undefined)card.style.setProperty('--custom-secondary-size',`${Number(p.secondarySize)}px`);else card.style.removeProperty('--custom-secondary-size');
    if(p.barThickness!==undefined)card.style.setProperty('--custom-bar-thickness',`${Number(p.barThickness)}px`);else card.style.removeProperty('--custom-bar-thickness');
    card.classList.toggle('odometer-mode',p.odometer===true||card.dataset.mode==='odometer');
    if(card.classList.contains('custom-metric-card')){const def=customWidgetDefs.find(w=>w.id===id),label=card.querySelector('.custom-label');if(label&&def)label.textContent=p.customLabel||def.label||'Custom';const units=card.querySelector('.custom-units');if(units)units.textContent=p.customUnits??def?.units??'';}
    else if(p.customLabel){const label=card.querySelector('.metric-label');if(label){const small=label.querySelector('small');label.childNodes.forEach(n=>{if(n.nodeType===Node.TEXT_NODE)n.textContent=''});label.insertBefore(document.createTextNode(p.customLabel+' '),small||null)}const unit=card.querySelector('.ios-value small')||card.querySelector('.metric-label small');if(unit&&p.customUnits!==undefined)unit.textContent=p.customUnits;}
    card.querySelectorAll('[data-part]').forEach(part=>{
      const partName=part.dataset.part;
      const visible=p.parts?.[partName]!==false;
      part.classList.toggle('custom-part-hidden',!visible);
      const offset=p.offsets?.[partName]||{x:0,y:0};
      const scale=partName==='bar'?(Number(p.barScale)||100)/100:1;
      part.style.transform=`translate(${Number(offset.x)||0}px,${Number(offset.y)||0}px) scale(${scale})`;
      part.style.transformOrigin='center center';
    });
    const scaleEls=card.querySelectorAll('.heel-scale,.trim-scale');
    scaleEls.forEach(el=>el.classList.toggle('custom-part-hidden',p.showScale===false));
    if(p.parts?.bar===false){card.querySelectorAll('.heel-bubble-wrap,.trim-gauge-wrap,.ewd-shift-line').forEach(el=>el.classList.add('custom-part-hidden'))}
    let extra=card.querySelector('.custom-extra-bar');
    if(p.extraBar===true&&!extra){extra=document.createElement('div');extra.className='custom-extra-bar';extra.dataset.part='extraBar';extra.innerHTML='<span></span>';const foot=card.querySelector('.ios-foot');card.insertBefore(extra,foot||null)}
    if(p.extraBar!==true&&extra)extra.remove();
    if(extra){extra.style.transform=`translate(${Number(p.offsets?.extraBar?.x)||0}px,${Number(p.offsets?.extraBar?.y)||0}px) scale(${(Number(p.barScale)||100)/100})`;extra.style.setProperty('--extra-thickness',`${Number(p.barThickness)||12}px`)}
    if(p.order!==undefined){
      const parent=card.parentElement;
      if(parent)parent.appendChild(card);
    }
  });
  cards.sort((a,b)=>(widgetPrefs[a.dataset.widget]?.order??100)-(widgetPrefs[b.dataset.widget]?.order??100)).forEach(card=>card.parentElement?.appendChild(card));
  loadWidgetForm();
  if(document.body.classList.contains('dashboard-editing')||document.body.classList.contains('dashboard-fullscreen'))applyCanvasLayout(true);
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
async function lockScreen(){
  if(watchId===null)requestGps();
  if(!motion.enabled)enableMotion();
  showView('cockpit');
  await enterDashboardFullscreen();
  locked=true;
  $('screenLockOverlay').classList.add('active');
  $('screenLockOverlay').setAttribute('aria-hidden','false');
  document.body.classList.add('app-locked');
  $('tapProgress').textContent='LONG PRESS TO UNLOCK';
  try{if('wakeLock' in navigator&&!wakeLock)wakeLock=await navigator.wakeLock.request('screen')}catch(e){}
}
function unlockScreen(){
  locked=false;
  $('screenLockOverlay').classList.remove('active');
  $('screenLockOverlay').setAttribute('aria-hidden','true');
  document.body.classList.remove('app-locked');
  clearTimeout(unlockHoldTimer);unlockHoldTimer=null;
  if(document.body.classList.contains('dashboard-fullscreen'))exitDashboardFullscreen();
  $('dashboardEditor').hidden=true;
}
function startUnlockHold(){
  if(!locked)return;
  $('tapProgress').textContent='KEEP HOLDING…';clearTimeout(unlockHoldTimer);
  unlockHoldTimer=setTimeout(()=>{unlockScreen();toast('Dashboard unlocked')},1800);
}
function cancelUnlockHold(){clearTimeout(unlockHoldTimer);unlockHoldTimer=null;if(locked)$('tapProgress').textContent='LONG PRESS TO UNLOCK'}
const CHANNELS=[
 {id:'timestamp',label:'Timestamp',group:'GPS / time',unit:'',max:86400},{id:'latitude',label:'Latitude',group:'GPS / time',unit:'°',max:90},{id:'longitude',label:'Longitude',group:'GPS / time',unit:'°',max:180},{id:'sog',label:'SOG · Speed Over Ground',group:'GPS / time',unit:'kn',max:20},{id:'cog',label:'COG · Course Over Ground',group:'GPS / time',unit:'°',max:360},{id:'gps-altitude',label:'GPS Altitude',group:'GPS / time',unit:'m',max:3000},{id:'heel',label:'Heel',group:'Motion',unit:'°',max:16},{id:'pitch',label:'Pitch',group:'Motion',unit:'°',max:10},
 {id:'race-timer',label:'Race Timer',group:'Start / line',unit:'',max:1800},{id:'time-to-start',label:'Time to Start',group:'Start / line',unit:'',max:1800},{id:'distance-to-line',label:'Distance to Line',group:'Start / line',unit:'m',max:500},{id:'time-to-line',label:'Time to Line',group:'Start / line',unit:'',max:600},{id:'time-to-kill',label:'Time to Kill',group:'Start / line',unit:'',max:600},{id:'line-length',label:'Line Length',group:'Start / line',unit:'m',max:1000},{id:'line-square',label:'Line Square',group:'Start / line',unit:'°',max:90},{id:'line-bias',label:'Line Bias',group:'Start / line',unit:'m',max:300},{id:'line-length-at-sog',label:'Line Length at SOG',group:'Start / line',unit:'s',max:1800},{id:'start-line',label:'Start Line',group:'Start / line',unit:'',max:1},{id:'race-events',label:'Race Events / elapsed',group:'Start / line',unit:'',max:100},
 {id:'vmg',label:'VMG',group:'Boat performance',unit:'kn',max:15},{id:'wind-angle',label:'Wind Angle',group:'Boat performance',unit:'°',max:180},{id:'speed-port',label:'Average Speed · Port Tack',group:'Boat performance',unit:'kn',max:20},{id:'speed-starboard',label:'Average Speed · Starboard Tack',group:'Boat performance',unit:'kn',max:20},{id:'tack-speed-delta',label:'Port / Starboard Speed Delta',group:'Boat performance',unit:'kn',max:10},{id:'ewd',label:'EWD · Estimated Wind Direction',group:'Wind',unit:'°',max:360},{id:'wind-shift',label:'Wind Shift',group:'Wind',unit:'°',max:45}
];
const channelHistory={};
function fillChannelSelectors(){const sel=$('newWidgetSource'),list=$('channelLibraryList');if(!sel||sel.dataset.ready==='1')return;sel.innerHTML='';let group='';CHANNELS.forEach(c=>{if(c.group!==group){group=c.group;const og=document.createElement('optgroup');og.label=group;sel.append(og)}const opt=document.createElement('option');opt.value=c.id;opt.textContent=c.label;sel.lastElementChild.append(opt)});sel.dataset.ready='1';list.innerHTML='';CHANNELS.forEach(c=>{const row=document.createElement('div');row.className='channel-library-row';const label=document.createElement('span');label.textContent=c.label;const small=document.createElement('small');small.textContent=c.group;const info=document.createElement('div');info.append(label,small);const btn=document.createElement('button');btn.type='button';btn.className='secondary compact';btn.textContent='＋ Add';btn.addEventListener('click',()=>{sel.value=c.id;$('newWidgetLabel').value=c.label;$('newWidgetUnits').value=c.unit;$('newWidgetMode').value='number';createCustomWidget()});row.append(info,btn);list.append(row)});sel.addEventListener('change',()=>{const c=CHANNELS.find(x=>x.id===sel.value);if(c){$('newWidgetLabel').value=c.label;$('newWidgetUnits').value=c.unit}});}
function numericMetric(id){const el=$(id);if(!el)return null;const txt=(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();if(!txt||txt==='—')return null;const clock=txt.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);if(clock)return Number(clock[1])*60+Number(clock[2])+(Number(clock[3]||0)/60);const n=txt.replace(/,/g,'.').match(/-?\d+(?:\.\d+)?/);return n?Number(n[0]):null}
function channelAverage(values){const a=(values||[]).filter(Number.isFinite);return a.length?a.reduce((sum,v)=>sum+v,0)/a.length:null}
function tackAverageSpeed(type){const segs=tackSegments[type]||[];const vals=segs.flatMap(seg=>(seg.samples||[]).map(x=>x.sog)).filter(Number.isFinite);return channelAverage(vals)}
function channelValue(source){if(source==='trim')source='pitch';if(source==='clock')return {value:elapsed()/1000,max:3600,unit:'',display:fmtTime(elapsed())};if(source==='gps-accuracy')source='gps-accuracy';const c=CHANNELS.find(x=>x.id===source),coords=lastFix?.coords||{};let value=null;
 const speed=coords.speed==null?null:Math.max(0,coords.speed*KNOTS_PER_MS),course=coords.heading??null;
 switch(source){case'timestamp':return {value:Date.now()/1000,max:86400,unit:'',display:new Date().toLocaleTimeString()};case'latitude':value=lastFix?.coords?.latitude??null;break;case'longitude':value=lastFix?.coords?.longitude??null;break;case'sog':value=speed;break;case'cog':value=course;break;case'gps-altitude':value=coords.altitude??null;break;case'gps-accuracy':value=coords.accuracy??null;break;case'heel':value=correctedMotion('heel');break;case'pitch':value=correctedMotion('pitch');break;case'race-timer':value=remainingGunSeconds();break;case'time-to-start':value=remainingGunSeconds();break;case'distance-to-line':value=numericMetric('lineDistance');break;case'time-to-line':value=numericMetric('timeToLine');break;case'time-to-kill':value=numericMetric('timeToBurn');break;case'line-length':{const nm=getLineLengthNm();value=nm==null?null:nm*1852;break}case'line-square':value=numericMetric('lineSquare');break;case'line-bias':{const sq=numericMetric('lineSquare'),len=getLineLengthNm();value=sq==null||len==null?null:Math.sin(Math.abs(sq)*Math.PI/180)*len*1852;break}case'line-length-at-sog':value=numericMetric('lineLengthSeconds');break;case'start-line':value=raceMarks.committee&&raceMarks.pin?1:0;break;case'race-events':value=(events||[]).length;break;case'vmg':{const hist=sogHistory.filter(x=>Date.now()-x.t<15000).map(x=>x.value);value=hist.length&&course!=null?channelAverage(hist)*Math.cos((course-(autoWindState.direction??course))*Math.PI/180):null;break;}case'wind-angle':value=course==null||autoWindState.direction==null?null:Math.abs(angularDelta(course,autoWindState.direction));break;case'speed-port':value=tackAverageSpeed('port');break;case'speed-starboard':value=tackAverageSpeed('starboard');break;case'tack-speed-delta':{const a=tackAverageSpeed('port'),b=tackAverageSpeed('starboard');value=a==null||b==null?null:a-b;break}case'ewd':value=autoWindState.direction;break;case'wind-shift':value=autoWindState.direction==null||windBaseline==null?null:angularDelta(autoWindState.direction,windBaseline);break;}
 return {value,max:c?.max||100,unit:c?.unit||'',display:null};
}
function renderWidgetVisibility(){
 const host=$('widgetVisibilityList');if(!host)return;host.innerHTML='';
 const labels={'live-sog':'SOG','live-course':'COG','live-heel':'HEEL','trim':'TRIM','wind-detail':'EWD'};customWidgetDefs.forEach(w=>labels[w.id]=w.label||'Custom');
 Object.entries(labels).forEach(([id,label])=>{const row=document.createElement('label');row.className='widget-visibility-item';const cb=document.createElement('input');cb.type='checkbox';cb.checked=widgetPrefs[id]?.visibilityOverride===true?widgetPrefs[id]?.hidden!==true:!(widgetPrefs[id]?.hidden===true||(localStorage.getItem('saillabDashboardLayout')==='minimal'&&id==='trim'));cb.addEventListener('change',()=>{widgetPrefs[id]={...(widgetPrefs[id]||{}),hidden:!cb.checked,visibilityOverride:true};localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyWidgetPrefs();applyDashboardLayout();});const span=document.createElement('span');span.textContent=label;row.append(cb,span);host.append(row)});
}
function loadEditorWidgetForm(){
 const id=$('editorWidgetSelect')?.value;if(!id)return;
 const p=widgetPrefs[id]||{}, parts=p.parts||{}, offsets=p.offsets||{};
 $('editorWidgetWidth').value=p.width||'half';$('editorWidgetFont').value=p.font||'medium';$('editorWidgetChartMode').value=customWidgetDefs.find(w=>w.id===id)?.mode||p.chartMode||'number';
 $('editorWidgetBg').value=p.bg||'#101f2e';$('editorWidgetColor').value=p.color||'#f1f6fa';
 const defaultSizes={'live-sog':96,'live-course':72,'live-heel':68,'trim':68,'wind-detail':68};
 $('editorValueSize').value=p.valueSize||defaultSizes[id]||68;$('editorLabelSize').value=p.labelSize||9;$('editorSecondarySize').value=p.secondarySize||10;
 $('editorDecimals').value=p.decimals===undefined?'default':String(p.decimals);
 $('editorBarScale').value=p.barScale||100;$('editorBarThickness').value=p.barThickness||12;$('editorZeroCenter').checked=p.zeroCenter===true;$('editorDamping').value=String(p.dampingSec??0);$('editorMarkers').value=Array.isArray(p.markers)?p.markers.join(', '):'';
 $('editorPositionPart').value=p.positionPart||'value';const off=offsets[$('editorPositionPart').value]||{x:0,y:0};$('editorOffsetX').value=off.x||0;$('editorOffsetY').value=off.y||0;
 $('editorOdometer').checked=p.odometer===true;
 $('partShowLabel').checked=parts.label!==false;$('partShowValue').checked=parts.value!==false;$('partShowSecondary').checked=parts.secondary!==false;$('partShowAverages').checked=parts.averages!==false;$('partShowBar').checked=parts.bar!==false;$('partShowScale').checked=p.showScale!==false;$('partShowExtraBar').checked=p.extraBar===true;
 $('editorWidgetHide').textContent=p.hidden?'Show widget':'Hide widget';
 const def=customWidgetDefs.find(w=>w.id===id);const card=document.querySelector(`#dashboardGrid [data-widget="${id}"]`);const defaultLabel=def?.label||({ 'live-sog':'SOG','live-course':'COG','live-heel':'HEEL','trim':'TRIM','wind-detail':'EWD'}[id]||'Widget');
 $('editorCustomLabel').value=p.customLabel??defaultLabel;$('editorCustomUnits').value=p.customUnits??def?.units??(card?.querySelector('.ios-value small')?.textContent||card?.querySelector('.metric-label small')?.textContent||'');
 $('deleteCustomWidget').hidden=!id.startsWith('custom-');
 updateFineTuneOutputs();
}
function updateFineTuneOutputs(){
 const pairs=[['editorValueSize','editorValueSizeOut',' px'],['editorLabelSize','editorLabelSizeOut',' px'],['editorSecondarySize','editorSecondarySizeOut',' px'],['editorOffsetX','editorOffsetXOut',' px'],['editorOffsetY','editorOffsetYOut',' px'],['editorBarScale','editorBarScaleOut','%'],['editorBarThickness','editorBarThicknessOut',' px']];
 pairs.forEach(([input,out,suffix])=>{if($(input)&&$(out))$(out).textContent=$(input).value+suffix});
}
function saveEditorWidget(){
 const id=$('editorWidgetSelect').value,prev=widgetPrefs[id]||{},partName=$('editorPositionPart').value,offsets={...(prev.offsets||{})};
 offsets[partName]={x:Number($('editorOffsetX').value)||0,y:Number($('editorOffsetY').value)||0};
 widgetPrefs[id]={...prev,width:$('editorWidgetWidth').value,font:$('editorWidgetFont').value,bg:$('editorWidgetBg').value,color:$('editorWidgetColor').value,customLabel:$('editorCustomLabel').value.trim(),customUnits:$('editorCustomUnits').value.trim(),
  valueSize:Number($('editorValueSize').value),labelSize:Number($('editorLabelSize').value),secondarySize:Number($('editorSecondarySize').value),
  decimals:$('editorDecimals').value==='default'?undefined:Number($('editorDecimals').value),barScale:Number($('editorBarScale').value),barThickness:Number($('editorBarThickness').value),zeroCenter:$('editorZeroCenter').checked,dampingSec:Number($('editorDamping').value)||0,markers:$('editorMarkers').value.split(',').map(v=>Number(v.trim())).filter(Number.isFinite).slice(0,12),
  positionPart:partName,offsets,odometer:$('editorOdometer').checked,showScale:$('partShowScale').checked,extraBar:$('partShowExtraBar').checked,
  chartMode:$('editorWidgetChartMode').value,parts:{...(prev.parts||{}),label:$('partShowLabel').checked,value:$('partShowValue').checked,secondary:$('partShowSecondary').checked,averages:$('partShowAverages').checked,bar:$('partShowBar').checked}};
 if(prev.canvas){const c={...prev.canvas};if($('editorWidgetWidth').value==='full'){c.w=Math.max(c.w,96);c.x=2}else if(prev.width==='full'&&$('editorWidgetWidth').value==='half'){c.w=47;c.x=Math.min(c.x,51)}widgetPrefs[id].canvas=c;}
 const def=customWidgetDefs.find(w=>w.id===id);if(def){def.label=$('editorCustomLabel').value.trim()||'Custom';def.units=$('editorCustomUnits').value.trim();def.mode=$('editorWidgetChartMode').value;const selectedCard=document.querySelector(`#dashboardGrid [data-widget="${id}"]`);if(selectedCard){selectedCard.dataset.mode=def.mode;selectedCard.querySelector('.custom-widget-meter').hidden=def.mode!=='bar';selectedCard.querySelector('.custom-widget-vertical').hidden=def.mode!=='vertical';selectedCard.querySelector('.custom-widget-chart').hidden=def.mode!=='chart';}localStorage.setItem('saillabCustomWidgets',JSON.stringify(customWidgetDefs));syncEditorWidgetOptions();}
 localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyWidgetPrefs();applyDashboardLayout();applyCanvasLayout(document.body.classList.contains('dashboard-editing')||document.body.classList.contains('dashboard-fullscreen'));renderCustomWidgets();updateFineTuneOutputs();renderWidgetVisibility();
}
function openDashboardEditor(){
 if(locked)unlockScreen();
 $('dashboardEditor').hidden=false;document.body.classList.add('dashboard-editing');
 initCustomWidgets();syncEditorWidgetOptions();applyWidgetPrefs();applyCanvasLayout(true);setupCanvasDragHandles();
 loadEditorWidgetForm();renderWidgetVisibility();$('dashboardPhoneFrame').scrollIntoView({behavior:'smooth',block:'center'});
}
function closeDashboardEditor(){
 $('dashboardEditor').hidden=true;document.body.classList.remove('dashboard-editing');teardownCanvasDragHandles();if(!document.body.classList.contains('dashboard-fullscreen'))applyCanvasLayout(false);
}
async function enterDashboardFullscreen(){
 closeDashboardEditor();
 document.body.classList.add('cockpit-presentation','dashboard-fullscreen');
 $('exitDashboardBtn').hidden=false;applyCanvasLayout(true);
 try{if(!document.fullscreenElement&&document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen()}catch(e){/* CSS fullscreen fallback remains available */}
 try{if('wakeLock' in navigator&&!wakeLock)wakeLock=await navigator.wakeLock.request('screen')}catch(e){}
 toast('Dashboard full screen · tap Exit to return');
}
async function exitDashboardFullscreen(){
 document.body.classList.remove('cockpit-presentation','dashboard-fullscreen');$('exitDashboardBtn').hidden=true;applyCanvasLayout(false);
 if(document.fullscreenElement&&document.exitFullscreen){try{await document.exitFullscreen()}catch(e){}}
 if(wakeLock){try{await wakeLock.release()}catch(e){}wakeLock=null}
}
function syncEditorWidgetOptions(){
 const select=$('editorWidgetSelect');if(!select)return;const existing=new Set([...select.options].map(o=>o.value));
 customWidgetDefs.forEach(w=>{let opt=[...select.options].find(o=>o.value===w.id);if(!opt){opt=document.createElement('option');opt.value=w.id;select.append(opt)}opt.textContent=`${w.label||'Custom'} · custom`});
 [...select.options].forEach(o=>{if(o.value.startsWith('custom-')&&!customWidgetDefs.some(w=>w.id===o.value))o.remove()});
}
function initCustomWidgets(){
 fillChannelSelectors();const grid=$('dashboardGrid');if(!grid)return;
 customWidgetDefs.forEach(def=>{if(grid.querySelector(`[data-widget="${def.id}"]`))return;const card=document.createElement('article');card.className='panel dash-widget ios-card custom-metric-card';card.dataset.widget=def.id;card.dataset.source=def.source;card.dataset.mode=def.mode||'number';card.innerHTML=`<div class="ios-card-head" data-part="label"><span class="ios-symbol custom-symbol">+</span><span class="metric-label custom-label"></span></div><div class="ios-value custom-main-value" data-part="value"><span class="custom-value">—</span><small class="custom-units"></small></div><div class="custom-widget-meter" data-part="bar" hidden><i class="custom-zero-line"></i><span></span><div class="custom-marker-layer"></div></div><div class="custom-widget-vertical" data-part="bar" hidden><i class="custom-zero-line"></i><span></span><div class="custom-marker-layer"></div></div><div class="custom-widget-chart" data-part="chart" hidden><div class="custom-chart-marker-layer"></div></div><div class="ios-foot custom-secondary" data-part="secondary"></div>`;card.querySelector('.custom-label').textContent=def.label||'Custom';card.querySelector('.custom-units').textContent=def.units||'';card.querySelector('.custom-secondary').textContent=`${def.source.toUpperCase()} · ${def.mode||'number'}`;if(def.mode==='bar')card.querySelector('.custom-widget-meter').hidden=false;if(def.mode==='vertical')card.querySelector('.custom-widget-vertical').hidden=false;if(def.mode==='chart')card.querySelector('.custom-widget-chart').hidden=false;if(def.mode==='odometer')card.classList.add('odometer-mode');grid.append(card)});
 syncEditorWidgetOptions();
}
function createCustomWidget(){
 const source=$('newWidgetSource').value;const channel=CHANNELS.find(c=>c.id===source);const label=$('newWidgetLabel').value.trim()||channel?.label||'Custom';const mode=$('newWidgetMode').value;const units=$('newWidgetUnits').value.trim()||channel?.unit||'';
 const id='custom-'+Date.now().toString(36);const def={id,label,source,mode,units};customWidgetDefs.push(def);localStorage.setItem('saillabCustomWidgets',JSON.stringify(customWidgetDefs));
 initCustomWidgets();widgetPrefs[id]={width:'half',font:'medium',valueSize:44,labelSize:9,secondarySize:9,bg:'#101f2e',color:'#f1f6fa'};localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));
 const select=$('editorWidgetSelect');select.value=id;applyWidgetPrefs();applyCanvasLayout(true);setupCanvasDragHandles();loadEditorWidgetForm();renderWidgetVisibility();renderCustomWidgets();toast('Custom widget created — drag it into position');
}
function deleteSelectedCustomWidget(){
 const id=$('editorWidgetSelect').value;if(!id.startsWith('custom-'))return;if(!confirm('Delete this custom widget?'))return;
 customWidgetDefs=customWidgetDefs.filter(w=>w.id!==id);localStorage.setItem('saillabCustomWidgets',JSON.stringify(customWidgetDefs));delete widgetPrefs[id];localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));document.querySelector(`#dashboardGrid [data-widget="${id}"]`)?.remove();syncEditorWidgetOptions();renderWidgetVisibility();$('editorWidgetSelect').value='live-sog';applyWidgetPrefs();applyCanvasLayout(true);loadEditorWidgetForm();toast('Custom widget deleted');
}
function sourceWidgetValue(def){const c=channelValue(def.source);return {value:c.value,max:c.max||1,unit:def.units||c.unit||'',display:c.display}}
function renderCustomWidgets(){
 if(!$('dashboardGrid'))return;
 const now=Date.now();
 customWidgetDefs.forEach(def=>{
  const card=$(`widget-${def.id}`)||document.querySelector(`#dashboardGrid [data-widget="${def.id}"]`);if(!card)return;
  const pref=widgetPrefs[def.id]||{};let {value,max,unit,display}=sourceWidgetValue(def);
  const windowMs=Math.max(0,Number(pref.dampingSec)||0)*1000;
  const history=channelHistory[def.id]||(channelHistory[def.id]=[]);
  if(Number.isFinite(value)){if(!history.length||now-history[history.length-1].t>=250)history.push({t:now,v:value});}
  while(history.length&&now-history[0].t>Math.max(10000,windowMs+5000))history.shift();
  if(windowMs>0&&Number.isFinite(value)){
   const recent=history.filter(x=>now-x.t<=windowMs).map(x=>x.v);
   if(recent.length)value=channelAverage(recent);
  }
  const val=card.querySelector('.custom-value');
  if(val){if(display!=null)val.textContent=display;else if(value==null||!Number.isFinite(value))val.textContent='—';else if(['race-timer','time-to-start','time-to-line','time-to-kill','line-length-at-sog'].includes(def.source))val.textContent=fmtClock(Math.max(0,value));else val.textContent=widgetNumber(def.id,value,def.source==='cog'||def.source==='ewd'||def.source==='line-square'||def.source==='wind-angle'?0:1)}
  const u=card.querySelector('.custom-units');if(u)u.textContent=unit;
  const markers=(Array.isArray(pref.markers)?pref.markers:[]).filter(Number.isFinite);
  const zeroCenter=pref.zeroCenter===true;
  const scale=Math.max(0.001,Number(max)||1);
  const markerPct=(m)=>zeroCenter?50+(Math.max(-scale,Math.min(scale,m))/(2*scale))*100:Math.max(0,Math.min(100,m/scale*100));
  const meter=card.querySelector('.custom-widget-meter');
  if(meter){meter.hidden=def.mode!=='bar';meter.classList.toggle('zero-centered',zeroCenter);meter.style.setProperty('--custom-bar-thickness',(pref.barThickness||10)+'px');const fill=meter.querySelector('span');const pct=value==null?0:zeroCenter?Math.min(50,Math.abs(value)/scale*50):Math.min(100,Math.abs(value)/scale*100);fill.style.width=pct+'%';fill.style.left=zeroCenter?(value<0?50-pct:50)+'%':'0%';fill.style.right=zeroCenter?(value<0?50:50-pct)+'%':'auto';fill.classList.toggle('negative',Number(value)<0);const ml=meter.querySelector('.custom-marker-layer');ml.innerHTML='';markers.forEach(m=>{const tick=document.createElement('i');tick.className='custom-marker';tick.style.setProperty('--marker-left',markerPct(m)+'%');tick.title=String(m);ml.append(tick)});}
  const vertical=card.querySelector('.custom-widget-vertical');
  if(vertical){vertical.hidden=def.mode!=='vertical';vertical.classList.toggle('zero-centered',zeroCenter);const fill=vertical.querySelector('span');const pct=value==null?0:zeroCenter?Math.min(50,Math.abs(value)/scale*50):Math.min(100,Math.abs(value)/scale*100);fill.style.height=pct+'%';fill.style.bottom=zeroCenter?(value<0?50-pct:50)+'%':'0%';fill.style.top=zeroCenter?(value<0?50:50-pct)+'%':'auto';fill.classList.toggle('negative',Number(value)<0);const ml=vertical.querySelector('.custom-marker-layer');ml.innerHTML='';markers.forEach(m=>{const tick=document.createElement('i');tick.className='custom-marker';tick.style.setProperty('--marker-bottom',markerPct(m)+'%');tick.title=String(m);ml.append(tick)});}
  const chart=card.querySelector('.custom-widget-chart');
  if(chart){chart.hidden=def.mode!=='chart';if(def.mode==='chart'){
   const stepMs=Math.max(500,Number(pref.dampingSec||1)*1000);
   if(Number.isFinite(value)&&(!history._chartLast||now-history._chartLast>=stepMs)){history._chartLast=now;history._chart=(history._chart||[]).concat([{t:now,v:value}]).slice(-36)}
   const vals=(history._chart||[]).map(x=>x.v);const lo=zeroCenter?-scale:Math.min(...vals,0),hi=zeroCenter?scale:Math.max(...vals,1),range=hi-lo||1;
   chart.innerHTML='<div class="custom-chart-marker-layer"></div><div class="custom-chart-zero-line"></div>';
   const layer=chart.querySelector('.custom-chart-marker-layer');markers.forEach(m=>{const tick=document.createElement('i');tick.className='custom-chart-marker';tick.style.bottom=Math.max(0,Math.min(100,(m-lo)/range*100))+'%';tick.title=String(m);layer.append(tick)});
   if(zeroCenter){const zero=chart.querySelector('.custom-chart-zero-line');zero.style.bottom=((0-lo)/range*100)+'%'}
   vals.forEach(v=>{const bar=document.createElement('i');bar.className='custom-chart-column';if(zeroCenter){const zero=(0-lo)/range*100,point=(v-lo)/range*100;bar.style.bottom=Math.min(zero,point)+'%';bar.style.height=Math.abs(point-zero)+'%';bar.classList.toggle('negative',v<0)}else bar.style.height=Math.max(4,(v-lo)/range*100)+'%';chart.append(bar)});
  }}
  card.classList.toggle('odometer-mode',def.mode==='odometer'||pref.odometer===true);card.classList.toggle('custom-vertical-mode',def.mode==='vertical');card.classList.toggle('custom-chart-mode',def.mode==='chart');
 });
}
const defaultCanvasPositions={
 race:{'live-sog':{x:2,y:2,w:47,h:18},'live-course':{x:51,y:2,w:47,h:18},'live-heel':{x:2,y:22,w:47,h:22},trim:{x:51,y:22,w:47,h:22},'wind-detail':{x:2,y:46,w:96,h:24}},
 balanced:{'live-sog':{x:2,y:2,w:47,h:18},'live-course':{x:51,y:2,w:47,h:18},'wind-detail':{x:2,y:22,w:96,h:23},'live-heel':{x:2,y:47,w:47,h:22},trim:{x:51,y:47,w:47,h:22}},
 minimal:{'live-sog':{x:2,y:3,w:47,h:22},'live-course':{x:51,y:3,w:47,h:22},'live-heel':{x:2,y:27,w:47,h:23},trim:{x:51,y:27,w:47,h:23},'wind-detail':{x:2,y:52,w:96,h:24}},
 big:{'live-sog':{x:2,y:2,w:96,h:20},'live-course':{x:2,y:24,w:47,h:19},'live-heel':{x:51,y:24,w:47,h:19},trim:{x:2,y:45,w:47,h:24},'wind-detail':{x:51,y:45,w:47,h:24}}
};
function canvasDefaultFor(id,index,layout){const positions=defaultCanvasPositions[layout]||defaultCanvasPositions.race;if(positions[id])return {...positions[id]};const n=Math.max(0,index-5);return {x:n%2?51:2,y:73+Math.floor(n/2)*12,w:47,h:11}}
function applyCanvasLayout(enable,resetPositions=false){
 const grid=$('dashboardGrid'),frame=$('dashboardPhoneFrame');if(!grid||!frame)return;
 const canvasActive=enable===true;
 grid.classList.toggle('free-position-canvas',canvasActive);frame.classList.toggle('phone-canvas-active',canvasActive);
 if(!canvasActive){[...grid.querySelectorAll('[data-widget]')].forEach(card=>{['position','left','top','width','height','zIndex'].forEach(k=>card.style[k]='');card.classList.remove('canvas-selected','canvas-dragging')});teardownCanvasDragHandles();return}
 const layout=localStorage.getItem('saillabDashboardLayout')||'race';const cards=[...grid.querySelectorAll('[data-widget]')];
 cards.forEach((card,index)=>{const id=card.dataset.widget;const pref=widgetPrefs[id]||{};let pos=pref.canvas;if(resetPositions||!pos)pos=canvasDefaultFor(id,index,layout);pos={x:Number(pos.x)||0,y:Number(pos.y)||0,w:Number(pos.w)||47,h:Number(pos.h)||18};pos.x=Math.max(0,Math.min(100-pos.w,pos.x));pos.y=Math.max(0,Math.min(100-pos.h,pos.y));widgetPrefs[id]={...pref,canvas:pos};card.style.position='absolute';card.style.left=pos.x+'%';card.style.top=pos.y+'%';card.style.width=pos.w+'%';card.style.height=pos.h+'%';card.style.zIndex=String(pref.zIndex||index+1);card.classList.toggle('canvas-selected',id===$('editorWidgetSelect')?.value);});
 localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));if(document.body.classList.contains('dashboard-editing'))setupCanvasDragHandles();
}
function selectCanvasCard(card){if(!card)return;const id=card.dataset.widget;const sel=$('editorWidgetSelect');if(sel&&[...sel.options].some(o=>o.value===id)){sel.value=id;loadEditorWidgetForm()}document.querySelectorAll('#dashboardGrid [data-widget]').forEach(c=>c.classList.toggle('canvas-selected',c===card));}
function setupCanvasDragHandles(){
 const grid=$('dashboardGrid');if(!grid||!document.body.classList.contains('dashboard-editing'))return;
 grid.querySelectorAll('[data-widget]').forEach(card=>{
  if(!card.querySelector('.canvas-drag-handle')){const h=document.createElement('button');h.type='button';h.className='canvas-drag-handle';h.setAttribute('aria-label','Drag widget');h.title='Drag this widget';h.textContent='⠿';card.append(h)}
  if(!card.querySelector('.canvas-resize-handle')){const r=document.createElement('button');r.type='button';r.className='canvas-resize-handle';r.setAttribute('aria-label','Resize widget');r.title='Resize widget';r.textContent='↘';r.addEventListener('click',e=>e.stopPropagation());card.append(r)}
  if(!card.querySelector('.canvas-lock-handle')){const l=document.createElement('button');l.type='button';l.className='canvas-lock-handle';l.setAttribute('aria-label','Lock widget position and size');l.title='Lock widget position and size';l.addEventListener('click',e=>{e.stopPropagation();const id=card.dataset.widget;widgetPrefs[id]={...(widgetPrefs[id]||{}),locked:!(widgetPrefs[id]||{}).locked};localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));syncCanvasLockState(card);toast(widgetPrefs[id].locked?'Widget position and size locked':'Widget position and size unlocked')});card.append(l)}
  card.classList.add('canvas-draggable');syncCanvasLockState(card);
 });
}
function syncCanvasLockState(card){const id=card.dataset.widget,p=widgetPrefs[id]||{},btn=card.querySelector('.canvas-lock-handle');card.classList.toggle('canvas-widget-locked',!!p.locked);if(btn){btn.textContent=p.locked?'🔒':'🔓';btn.title=p.locked?'Unlock widget position':'Lock widget position';btn.setAttribute('aria-label',btn.title)}}
function teardownCanvasDragHandles(){document.querySelectorAll('.canvas-resize-handle,.canvas-drag-handle,.canvas-lock-handle').forEach(h=>h.remove());document.querySelectorAll('.canvas-draggable').forEach(c=>c.classList.remove('canvas-draggable'))}
function persistCanvasCard(card){const id=card.dataset.widget,p=widgetPrefs[id]||{};const rect=card.getBoundingClientRect(),gridRect=$('dashboardGrid').getBoundingClientRect();p.canvas={x:Math.round((rect.left-gridRect.left)/gridRect.width*1000)/10,y:Math.round((rect.top-gridRect.top)/gridRect.height*1000)/10,w:Math.round(rect.width/gridRect.width*1000)/10,h:Math.round(rect.height/gridRect.height*1000)/10};p.canvas.x=Math.max(0,Math.min(100-p.canvas.w,p.canvas.x));p.canvas.y=Math.max(0,Math.min(100-p.canvas.h,p.canvas.y));widgetPrefs[id]=p;localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyCanvasLayout(true);}
function initCanvasPointerEvents(){
 const grid=$('dashboardGrid');if(!grid||grid.dataset.pointerInit)return;grid.dataset.pointerInit='1';
 grid.addEventListener('pointerdown',e=>{if(!document.body.classList.contains('dashboard-editing'))return;const card=e.target.closest('[data-widget]');if(!card)return;const resize=e.target.closest('.canvas-resize-handle'),drag=e.target.closest('.canvas-drag-handle');if(!resize&&!drag){if(!e.target.closest('button,input,select,textarea,a'))selectCanvasCard(card);return}if((widgetPrefs[card.dataset.widget]||{}).locked){toast('Unlock this widget before moving or resizing it');return}selectCanvasCard(card);const rect=card.getBoundingClientRect(),g=grid.getBoundingClientRect();activePointerEdit={card,mode:resize?'resize':'drag',startX:e.clientX,startY:e.clientY,startLeft:rect.left-g.left,startTop:rect.top-g.top,startWidth:rect.width,startHeight:rect.height,gridWidth:g.width,gridHeight:g.height,moved:false};card.classList.add('canvas-dragging');try{card.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault()});
 document.addEventListener('pointermove',e=>{if(!activePointerEdit)return;const a=activePointerEdit,dx=e.clientX-a.startX,dy=e.clientY-a.startY;let x=a.startLeft,y=a.startTop,w=a.startWidth,h=a.startHeight;if(a.mode==='drag'){x+=dx;y+=dy}else{w+=dx;h+=dy}const minW=a.gridWidth*.22,minH=a.gridHeight*.09;w=Math.max(minW,Math.min(a.gridWidth,w));h=Math.max(minH,Math.min(a.gridHeight,h));x=Math.max(0,Math.min(a.gridWidth-w,x));y=Math.max(0,Math.min(a.gridHeight-h,y));a.card.style.left=(x/a.gridWidth*100)+'%';a.card.style.top=(y/a.gridHeight*100)+'%';a.card.style.width=(w/a.gridWidth*100)+'%';a.card.style.height=(h/a.gridHeight*100)+'%';if(Math.abs(dx)+Math.abs(dy)>3)a.moved=true});
 const end=e=>{if(!activePointerEdit)return;const a=activePointerEdit;a.card.classList.remove('canvas-dragging');persistCanvasCard(a.card);activePointerEdit=null};document.addEventListener('pointerup',end);document.addEventListener('pointercancel',end);
 grid.addEventListener('click',e=>{const card=e.target.closest('[data-widget]');if(card&&document.body.classList.contains('dashboard-editing')&&!e.target.closest('button'))selectCanvasCard(card)});
}
initCanvasPointerEvents();
function setupEditorControls(){
 $('customizeDashboard').onclick=openDashboardEditor;$('closeDashboardEditor').onclick=closeDashboardEditor;
 $('editorDoneLock').onclick=lockScreen;$('lockDashboardBtn').onclick=lockScreen;$('exitDashboardBtn').onclick=exitDashboardFullscreen;
 $('editorWidgetSelect').onchange=()=>{loadEditorWidgetForm();document.querySelectorAll('#dashboardGrid [data-widget]').forEach(c=>c.classList.toggle('canvas-selected',c.dataset.widget===$('editorWidgetSelect').value))};
 ['editorWidgetWidth','editorWidgetFont','editorWidgetBg','editorWidgetColor','editorCustomLabel','editorCustomUnits','editorDecimals','editorOdometer','editorWidgetChartMode','partShowLabel','partShowValue','partShowSecondary','partShowAverages','partShowBar','partShowScale','partShowExtraBar','editorBarScale','editorBarThickness','editorZeroCenter','editorDamping','editorMarkers','editorValueSize','editorLabelSize','editorSecondarySize','editorOffsetX','editorOffsetY'].forEach(id=>$(id).addEventListener(['editorValueSize','editorLabelSize','editorSecondarySize','editorOffsetX','editorOffsetY','editorBarScale','editorBarThickness'].includes(id)?'input':'change',saveEditorWidget));
 $('editorPositionPart').addEventListener('change',()=>{const p=widgetPrefs[$('editorWidgetSelect').value]||{},off=p.offsets?.[$('editorPositionPart').value]||{x:0,y:0};$('editorOffsetX').value=off.x||0;$('editorOffsetY').value=off.y||0;saveEditorWidget()});
 $('editorWidgetUp').onclick=()=>{ $('widgetSelect').value=$('editorWidgetSelect').value;moveWidget(-1);loadEditorWidgetForm() };
 $('editorWidgetDown').onclick=()=>{ $('widgetSelect').value=$('editorWidgetSelect').value;moveWidget(1);loadEditorWidgetForm() };
 $('editorWidgetHide').onclick=()=>{const id=$('editorWidgetSelect').value;widgetPrefs[id]={...(widgetPrefs[id]||{}),hidden:!(widgetPrefs[id]||{}).hidden,visibilityOverride:true};localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyWidgetPrefs();applyDashboardLayout();loadEditorWidgetForm();renderWidgetVisibility()};
 $('editorResetLayout').onclick=()=>{widgetPrefs={};localStorage.removeItem('saillabWidgetPrefs');applyDashboardLayout('race');applyWidgetPrefs();loadEditorWidgetForm();toast('Dashboard layout reset')};
 $('createCustomWidget').onclick=createCustomWidget; $('deleteCustomWidget').onclick=deleteSelectedCustomWidget; setupCanvasDragHandles();
 document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&document.body.classList.contains('dashboard-fullscreen')){document.body.classList.remove('cockpit-presentation','dashboard-fullscreen');$('exitDashboardBtn').hidden=true;applyCanvasLayout(false);applyCanvasLayout(false)}});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('dashboard-fullscreen'))exitDashboardFullscreen()});
}
function resetWidgetPrefs(){
  widgetPrefs={};dashPrefs={};localStorage.removeItem('saillabWidgetPrefs');localStorage.removeItem('saillabDashPrefs');applyWidgetPrefs();toast('Widget layout reset');
}


async function persistSessionMeta(){if(!current)return;current={...current,...currentMeta(),samples:[...samples],events:[...events]};await dbPut(current)}
function renderDockTunePhotos(){const host=$('dockTunePhotosPreview');if(!host)return;host.innerHTML='';dockTunePhotos.forEach((src,index)=>{const wrap=document.createElement('div');wrap.className='dock-photo';const img=document.createElement('img');img.src=src;img.alt=`Dock tune photo ${index+1}`;const remove=document.createElement('button');remove.type='button';remove.className='secondary compact';remove.textContent='Remove';remove.onclick=()=>{dockTunePhotos.splice(index,1);renderDockTunePhotos();persistSessionMeta().catch(console.error)};wrap.append(img,remove);host.appendChild(wrap)})}
function compressPhoto(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=reject;reader.onload=()=>{const img=new Image();img.onerror=reject;img.onload=()=>{const scale=Math.min(1,1280/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/jpeg',0.78))};img.src=reader.result};reader.readAsDataURL(file)})}
async function handleDockPhotos(files){for(const file of [...files]){if(!file.type.startsWith('image/'))continue;try{if(dockTunePhotos.length>=8){toast('Maximum 8 dock tune photos');break}dockTunePhotos.push(await compressPhoto(file))}catch(e){console.warn(e);toast('Could not add one of the photos')}}renderDockTunePhotos();persistSessionMeta().catch(console.error)}
function createSession(){return {id:uid(),ownerId:saillabAuthUser?.id||null,createdAt:new Date().toISOString(),...currentMeta(),status:'recording',startedAt:new Date().toISOString(),durationMs:0,samples:[],events:[],gpx:false}}
async function saveCurrent(){if(!current)return;current={...current,ownerId:current.ownerId||saillabAuthUser?.id||null,...currentMeta(),samples:[...samples],events:[...events],durationMs:elapsed(),status:paused?'paused':'recording',updatedAt:new Date().toISOString()};await dbPut(current)}
async function start(){if(current&&current.status==='recording'){toast('Session already running');return}if(!navigator.geolocation){toast('Geolocation is not supported');return}if(!window.isSecureContext){toast('GPS requires HTTPS. Publish the app over HTTPS.');return}
 if(!current||['finished','imported'].includes(current.status)){current=createSession();samples=[];events=[];elapsedBeforePause=0;sessionStartMs=Date.now();paused=false}
 else{sessionStartMs=Date.now();paused=false}
 updateControls();requestGps();timerId=setInterval(()=>{if(current&&!paused){$('duration').textContent=fmtTime(elapsed());saveCurrent().catch(console.error)}},5000);toast('Recording started')}
function requestGps(){if(watchId!==null)return;let fixCount=0;watchId=navigator.geolocation.watchPosition(pos=>{fixCount++;lastFix=pos;const c=pos.coords;const speed=c.speed==null?null:Math.max(0,c.speed*KNOTS_PER_MS);if(Number.isFinite(speed)){sogHistory.push({t:pos.timestamp||Date.now(),value:speed});sogHistory=sogHistory.filter(x=>(Date.now()-x.t)<=60000)}if(Number.isFinite(c.heading)){courseHistory.push({t:pos.timestamp||Date.now(),course:c.heading,accuracy:c.accuracy});courseHistory=courseHistory.filter(x=>Date.now()-x.t<=240000)}const sample={t:pos.timestamp||Date.now(),lat:c.latitude,lon:c.longitude,alt:c.altitude==null?null:c.altitude,accuracy:c.accuracy==null?null:c.accuracy,sog:speed,course:c.heading==null?null:c.heading,heel:correctedMotion('heel'),pitch:correctedMotion('pitch')};if(current&&!paused){samples.push(sample);current.samples=samples;if(samples.length>100000){samples.shift()}if(lastSampleAt){const dt=(sample.t-lastSampleAt)/1000;if(dt>0)$('sampleRate').textContent=(1/dt).toFixed(1)+' Hz effective'}lastSampleAt=sample.t;updateStats();if(activeTack){const prev=activeTack.last;if(prev&&sample.course!=null)activeTack.courseSamples.push(sample.course);activeTack.last=sample;activeTack.distance+=prev?distanceNm(prev,sample):0;activeTack.samples.push(sample)}}
 $('gpsBadge').className='status ok';$('gpsBadge').innerHTML='<span class="dot"></span> GPS active';if($('sog'))$('sog').textContent=widgetNumber('live-sog',speed,1);if($('course'))$('course').textContent=widgetNumber('live-course',sample.course,0);if($('accuracy'))$('accuracy').textContent=sample.accuracy==null?'—':Math.round(sample.accuracy);if($('coords'))$('coords').textContent=`${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`;if($('samples'))$('samples').textContent=samples.length;if(typeof updateRaceMetrics==='function')updateRaceMetrics();if(typeof renderCockpit==='function')renderCockpit();},err=>{$('gpsBadge').className='status bad';$('gpsBadge').innerHTML='<span class="dot"></span> GPS unavailable';toast(({1:'GPS permission denied. Check your browser settings.',2:'GPS signal unavailable.',3:'GPS timed out. Try again outdoors.'})[err.code]||'GPS error');if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}if($('settingsGpsToggle'))$('settingsGpsToggle').textContent='Enable GPS'}, {enableHighAccuracy:true,maximumAge:1000,timeout:15000})}
function stopGps(){if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}}
function updateControls(){const active=!!current&&current.status==='recording';$('startBtn').disabled=active;$('pauseBtn').disabled=!active;$('resumeBtn').disabled=!(current&&paused);$('stopBtn').disabled=!current||!['recording','paused'].includes(current.status)}
async function pause(){if(!current||paused)return;elapsedBeforePause=elapsed();paused=true;sessionStartMs=null;await saveCurrent();updateControls();toast('Session paused')}
async function resume(){if(!current||!paused)return;sessionStartMs=Date.now();paused=false;await saveCurrent();updateControls();requestGps();toast('Recording resumed')}
async function finish(){if(!current)return;current.durationMs=elapsed();current.status='finished';current.finishedAt=new Date().toISOString();current={...current,...currentMeta(),samples:[...samples],events:[...events]};await dbPut(current);stopGps();clearInterval(timerId);timerId=null;sessionStartMs=null;paused=false;updateControls();renderSessions();renderAnalysis();toast('Session saved on this device')}
function updateStats(){const valid=samples.map(s=>s.sog).filter(Number.isFinite);const recent=sogHistory.filter(x=>Date.now()-x.t<=20000).map(x=>x.value);$('avgSpeed').textContent=recent.length?widgetNumber('live-sog',recent.reduce((a,b)=>a+b,0)/recent.length,1):'—';$('maxSpeed').textContent=valid.length?widgetNumber('live-sog',Math.max(...valid),1):'—';if($('samples'))$('samples').textContent=samples.length;const liveSog=$('sog');if(liveSog)liveSog.textContent=lastFix?.coords.speed==null?'—':(lastFix.coords.speed*KNOTS_PER_MS).toFixed(1);const duration=$('duration');if(duration)duration.textContent=fmtTime(elapsed())}
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
async function renderSessions(){const all=(await dbAll()).filter(s=>!saillabAuthUser||!s.ownerId||s.ownerId===saillabAuthUser.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));const list=$('sessionsList');list.innerHTML='';if(!all.length){list.innerHTML='<p class="muted">No saved sessions yet.</p>';return}for(const s of all){const row=document.createElement('div');row.className='session-row';const info=document.createElement('div');const title=document.createElement('div');title.className='session-title';title.textContent=s.name||'Unnamed session';const meta=document.createElement('div');meta.className='session-meta';meta.textContent=`${new Date(s.createdAt).toLocaleString('en-GB')} · ${(s.samples||[]).length} samples · ${s.status==='finished'?'finished':s.status==='imported'?'GPX imported':'incomplete'}`;info.append(title,meta);const actions=document.createElement('div');actions.className='session-actions';const load=document.createElement('button');load.textContent='Open';load.onclick=()=>loadSession(s.id);const exp=document.createElement('button');exp.textContent='JSON';exp.onclick=()=>downloadJson(s);const del=document.createElement('button');del.textContent='Delete';del.onclick=async()=>{if(confirm('Delete this session from this device?')){await dbDelete(s.id);if(current?.id===s.id){current=null;samples=[];events=[];updateControls()}renderSessions();toast('Session deleted')}};actions.append(load,exp,del);row.append(info,actions);list.append(row)}}
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
function applyTheme(theme){const allowed=['dark','light','blue','purple','yellow','teal','sunset','contrast'];const value=allowed.includes(theme)?theme:'blue';document.body.dataset.theme=value;document.documentElement.style.colorScheme=value==='light'?'light':'dark';if(themeSelect)themeSelect.value=value;localStorage.setItem('saillabTheme',value)}
if(themeSelect){themeSelect.value=localStorage.getItem('saillabTheme')||'blue';applyTheme(themeSelect.value);themeSelect.addEventListener('change',()=>{applyTheme(themeSelect.value);toast(`${themeSelect.options[themeSelect.selectedIndex].text} theme applied`)})}else applyTheme(localStorage.getItem('saillabTheme')||'blue');
$('sensorBtn').onclick=()=>{if(motion.enabled){window.removeEventListener('deviceorientation',onOrientation,true);motion.enabled=false;motion.heel=null;motion.pitch=null;updateMotionDisplay();$('sensorBtn').textContent='Enable IMU / motion sensors';toast('IMU / motion sensors disabled')}else enableMotion()};
const settingsTheme=$('settingsTheme');if(settingsTheme){settingsTheme.value=localStorage.getItem('saillabTheme')||'blue';settingsTheme.addEventListener('change',()=>{applyTheme(settingsTheme.value);if($('dashboardTheme'))$('dashboardTheme').value=settingsTheme.value})}if($('dashboardTheme')){$('dashboardTheme').value=localStorage.getItem('saillabTheme')||'blue';$('dashboardTheme').addEventListener('change',()=>{applyTheme($('dashboardTheme').value);if(settingsTheme)settingsTheme.value=$('dashboardTheme').value})}
const sailingMode=$('sailingMode');if(sailingMode){sailingMode.value=localStorage.getItem('saillabSailingMode')||'auto';sailingMode.addEventListener('change',()=>{localStorage.setItem('saillabSailingMode',sailingMode.value);renderAnalysis()})}
const settingsGps=$('settingsGpsToggle');if(settingsGps){settingsGps.onclick=()=>{if(watchId!==null){stopGps();settingsGps.textContent='Enable GPS';$('gpsBadge').className='status';$('gpsBadge').innerHTML='<span class="dot"></span> GPS inactive';toast('GPS stopped')}else{requestGps();settingsGps.textContent='Disable GPS'}}}

$('zeroHeelBtn').onclick=()=>setZero('heel');
$('zeroPitchBtn').onclick=()=>setZero('pitch');
$('lockScreenBtn').onclick=()=>{showView('cockpit');lockScreen()};
$('wakeLockBtn').onclick=toggleWakeLock;
$('widgetSelect').onchange=loadWidgetForm;
if($('maneuverFilter'))$('maneuverFilter').onchange=renderAnalysis;
if($('dockTunePhotosInput'))$('dockTunePhotosInput').addEventListener('change',e=>{handleDockPhotos(e.target.files||[]);e.target.value=''});
['widgetWidth','widgetFont','widgetBg','widgetColor'].forEach(id=>$(id).addEventListener('change',saveSelectedWidget));
$('widgetUp').onclick=()=>moveWidget(-1);
$('widgetDown').onclick=()=>moveWidget(1);
$('widgetHide').onclick=()=>{const id=$('widgetSelect').value;widgetPrefs[id]={...(widgetPrefs[id]||{}),hidden:!(widgetPrefs[id]||{}).hidden};localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyWidgetPrefs()};
$('widgetReset').onclick=resetWidgetPrefs;
$('screenLockOverlay').addEventListener('pointerdown',e=>{e.preventDefault();startUnlockHold()});
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
let raceMarks = JSON.parse(localStorage.getItem('saillabRaceMarks') || '{"committee":null,"pin":null,"upwind":null}');raceMarks.upwind=raceMarks.upwind||null;
tackSegments = JSON.parse(localStorage.getItem('saillabWindLegMeans') || '{"port":[],"starboard":[]}');
let gunDeadline = null, gunTimer = null, raceAutoSwitched = false;
let windBaseline = JSON.parse(localStorage.getItem('saillabWindBaseline') || 'null');
let trimReadings = JSON.parse(localStorage.getItem('saillabTrimReadings') || '[]');
let dashPrefs = JSON.parse(localStorage.getItem('saillabDashPrefs') || '{}');
let raceMap = null, dashMap = null, raceLayers = {}, dashLayers = {}; let weatherRaceMap=null,weatherRaceLayers={};
const DASH_NAMES = {map:'Boat & start-line map',sog:'SOG and COG',heel:'Heel and average',pitch:'Pitch',trim:'Manual trim average',wind:'Wind shift',line:'Start-line timing',chart:'Heel & trim chart'};
function fmtClock(seconds){if(!Number.isFinite(seconds))return '—';const n=Math.max(0,Math.round(Math.abs(seconds)));return `${seconds<0?'-':''}${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`}
function bearingDeg(a,b){const r=x=>x*Math.PI/180, dLon=r(b.lon-a.lon), y=Math.sin(dLon)*Math.cos(r(b.lat)), x=Math.cos(r(a.lat))*Math.sin(r(b.lat))-Math.sin(r(a.lat))*Math.cos(r(b.lat))*Math.cos(dLon);return (Math.atan2(y,x)*180/Math.PI+360)%360}
function angularDelta(a,b){return ((a-b+540)%360)-180}
function circularMean(degs){const vals=degs.filter(Number.isFinite);if(!vals.length)return null;const x=vals.reduce((s,d)=>s+Math.cos(d*Math.PI/180),0),y=vals.reduce((s,d)=>s+Math.sin(d*Math.PI/180),0);return (Math.atan2(y,x)*180/Math.PI+360)%360}
function fmtCoord(p){return p?`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`:'Not pinged'}
function currentPoint(){if(!lastFix)return null;return {lat:lastFix.coords.latitude,lon:lastFix.coords.longitude}}
function saveRaceMarks(){localStorage.setItem('saillabRaceMarks',JSON.stringify(raceMarks));updateRaceEndpoints();updateRaceMetrics();if(raceMap)raceMap._saillabFirstFit=false;if(dashMap)dashMap._saillabFirstFit=false;refreshMaps()}
function pingEndpoint(which){const point=currentPoint();if(!point){toast('Enable GPS first and wait for a position fix');requestGps();return}raceMarks[which]={...point,at:new Date().toISOString()};saveRaceMarks();toast(which==='committee'?'Committee boat ping saved':which==='pin'?'Pin ping saved':'Upwind mark ping saved')}
function getLineLengthNm(){return raceMarks.committee&&raceMarks.pin?distanceNm(raceMarks.committee,raceMarks.pin):null}
function crossTrackMeters(point,start,end){if(!point||!start||!end)return null;const rad=x=>x*Math.PI/180,R=6371000,lat0=rad(start.lat);const xy=p=>({x:R*rad(p.lon-start.lon)*Math.cos(lat0),y:R*rad(p.lat-start.lat)});const a=xy(start),b=xy(end),p=xy(point),dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;if(!len2)return Math.hypot(p.x-a.x,p.y-a.y);const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2));return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy))}
function updateRaceEndpoints(){if($('committeeStatus')){$('committeeStatus').textContent=raceMarks.committee?'Ping saved':'Not pinged';$('committeeCoords').textContent=fmtCoord(raceMarks.committee);$('pinStatus').textContent=raceMarks.pin?'Ping saved':'Not pinged';$('pinCoords').textContent=fmtCoord(raceMarks.pin);$('upwindStatus').textContent=raceMarks.upwind?'Ping saved':'Not pinged';$('upwindCoords').textContent=fmtCoord(raceMarks.upwind);const len=getLineLengthNm();$('lineLength').innerHTML=len==null?'—<small> nm</small>':`${len.toFixed(3)}<small> nm</small>`;const sog=lastFix?.coords.speed==null?null:lastFix.coords.speed*KNOTS_PER_MS;$('lineLengthSeconds').textContent=len!=null&&sog>0.15?fmtClock(len/sog*3600):'—'}}
function remainingGunSeconds(){return gunDeadline==null?null:(gunDeadline-Date.now())/1000}
function updateRaceMetrics(){if(!$('lineDistance'))return;const point=currentPoint(),lineReady=raceMarks.committee&&raceMarks.pin&&point;let dist=null,seconds=null;if(lineReady){dist=crossTrackMeters(point,raceMarks.committee,raceMarks.pin);const sog=lastFix?.coords.speed==null?null:lastFix.coords.speed*KNOTS_PER_MS;if(sog!=null&&sog>0.15)seconds=Math.abs(dist)/1852/sog*3600}
 $('lineDistance').innerHTML=dist==null?'—<small> m</small>':`${Math.round(Math.abs(dist))}<small> m</small>`;$('timeToLine').textContent=seconds==null?'—':fmtClock(seconds);const gun=remainingGunSeconds();$('gunCountdown').textContent=gun==null?fmtClock(Number($('gunSeconds')?.value||0)):fmtClock(gun);if(gun!=null){$('gunStatus').textContent=gun<=0?'GUN TIME':'Countdown running'}else $('gunStatus').textContent='Countdown not running';let burn=gun!=null&&seconds!=null?gun-seconds:null;$('timeToBurn').textContent=burn==null?'—':fmtClock(burn);$('burnHint').textContent=burn==null?'Set gun countdown and get a GPS fix':burn>=0?'Positive = time to kill / slow down':'Negative = estimated late';if($('dashBurn')){$('dashBurn').textContent=burn==null?'—':fmtClock(burn);$('dashTimeToLine').textContent=seconds==null?'—':fmtClock(seconds)}
 const currentSog=lastFix?.coords.speed==null?null:lastFix.coords.speed*KNOTS_PER_MS;const lineLenNow=getLineLengthNm();if($('lineLengthSeconds'))$('lineLengthSeconds').textContent=lineLenNow!=null&&currentSog>0.15?fmtClock(lineLenNow/currentSog*3600):'—';
 const sq=$('lineSquare'),sqHint=$('lineSquareHint');
 if(sq&&raceMarks.committee&&raceMarks.pin){const wind=windEstimate();if(wind){const lineBearing=bearingDeg(raceMarks.committee,raceMarks.pin);let angle=Math.abs(angularDelta(lineBearing,wind.direction));if(angle>90)angle=180-angle;const deviation=90-angle;sq.textContent=deviation<0.5?'Square':`±${deviation.toFixed(1)}°`;if(sqHint)sqHint.textContent=deviation<0.5?'Line is square to estimated wind':`${deviation.toFixed(1)}° off square · based on estimated wind`}else{sq.textContent='—';if(sqHint)sqHint.textContent='Record both tacks to estimate wind direction'}}else if(sq){sq.textContent='—';if(sqHint)sqHint.textContent='Ping both endpoints first'}
}
function finishGunCountdown(){if(gunTimer)clearInterval(gunTimer);gunTimer=null;$('gunCountdown').textContent='00:00';$('gunStatus').textContent='START — switching to cockpit';toast('Start! Switching to cockpit');if(!raceAutoSwitched){raceAutoSwitched=true;setTimeout(()=>showView('cockpit'),900)}}
function ensureGunTimer(){if(gunTimer)clearInterval(gunTimer);gunTimer=setInterval(()=>{updateRaceMetrics();if(remainingGunSeconds()<=0){gunDeadline=null;finishGunCountdown()}},100)}
function startGunCountdown(){const sec=Math.max(0,Number($('gunSeconds').value)||0);if(sec<=0){toast('Set a countdown greater than zero');return}gunDeadline=Date.now()+sec*1000;localStorage.setItem('saillabGunSeconds',String(sec));raceAutoSwitched=false;ensureGunTimer();updateRaceMetrics();toast('Start countdown running')}
function syncGunToMinute(){const now=Date.now();if(gunDeadline!=null){const remaining=Math.max(0,Math.ceil((gunDeadline-now)/1000));const snapped=Math.floor(remaining/60)*60;if(snapped<=0){gunDeadline=now;updateRaceMetrics();finishGunCountdown();return}gunDeadline=now+snapped*1000;$('gunSeconds').value=String(snapped);localStorage.setItem('saillabGunSeconds',String(snapped));if(!gunTimer)ensureGunTimer();updateRaceMetrics();toast(`Countdown synced to ${fmtClock(snapped)}`);return}const selected=Math.max(0,Number($('gunSeconds').value)||0);const snapped=Math.floor(selected/60)*60;$('gunSeconds').value=String(snapped);localStorage.setItem('saillabGunSeconds',String(snapped));updateRaceMetrics();toast(`Set to whole minute: ${fmtClock(snapped)}`)}
function adjustGunMinutes(delta){const input=$('gunSeconds');const next=Math.max(0,(Number(input.value)||0)+delta*60);input.value=String(next);localStorage.setItem('saillabGunSeconds',String(next));if(gunDeadline!=null){gunDeadline+=delta*60000;if(gunTimer==null&&remainingGunSeconds()>0){gunTimer=setInterval(()=>{updateRaceMetrics();if(remainingGunSeconds()<=0){clearInterval(gunTimer);gunTimer=null;$('gunCountdown').textContent='00:00';$('gunStatus').textContent='START — switching to cockpit';toast('Start! Switching to cockpit');if(!raceAutoSwitched){raceAutoSwitched=true;setTimeout(()=>showView('cockpit'),900)}}},100)}}updateRaceMetrics()}
function resetGunCountdown(){if(gunTimer)clearInterval(gunTimer);gunTimer=null;gunDeadline=null;raceAutoSwitched=false;updateRaceMetrics()}
function initMap(containerId,which){if(typeof L==='undefined')return null;const el=$(containerId);if(!el)return null;const map=L.map(el,{zoomControl:true,attributionControl:true}).setView([41.0,9.0],10);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);const layers={};layers.upwind=L.circleMarker([41,9],{radius:7,color:'#7be0aa',fillColor:'#7be0aa',fillOpacity:1,weight:2}).bindTooltip('Upwind mark');layers.boat=L.circleMarker([41,9],{radius:7,color:'#54e0c0',fillColor:'#54e0c0',fillOpacity:1,weight:2}).bindTooltip('Your boat');layers.committee=L.circleMarker([41,9],{radius:7,color:'#a78bfa',fillColor:'#a78bfa',fillOpacity:1,weight:2}).bindTooltip('Committee boat');layers.pin=L.circleMarker([41,9],{radius:7,color:'#ffb454',fillColor:'#ffb454',fillOpacity:1,weight:2}).bindTooltip('Pin');layers.line=L.polyline([[41,9],[41,9]],{color:'#f1f6fa',weight:3,dashArray:'7 6'});layers.upwindLeg=L.polyline([],{color:'#5ce0bd',weight:2,dashArray:'5 5'});Object.values(layers).forEach(l=>l.addTo(map));if(which==='race'){raceMap=map;raceLayers=layers}else{dashMap=map;dashLayers=layers}refreshMap(which);return map}
function refreshMap(which){const map=which==='race'?raceMap:dashMap,layers=which==='race'?raceLayers:dashLayers;if(!map||!layers)return;const p=currentPoint();if(p){layers.boat.setLatLng([p.lat,p.lon]);layers.boat.setStyle({opacity:1,fillOpacity:1})}else layers.boat.setStyle({opacity:0,fillOpacity:0});for(const k of ['committee','pin','upwind']){const v=raceMarks[k];if(v){layers[k].setLatLng([v.lat,v.lon]);layers[k].setStyle({opacity:1,fillOpacity:1})}else layers[k].setStyle({opacity:0,fillOpacity:0})}if(raceMarks.committee&&raceMarks.pin)layers.line.setLatLngs([[raceMarks.committee.lat,raceMarks.committee.lon],[raceMarks.pin.lat,raceMarks.pin.lon]]);else layers.line.setLatLngs([]);if(raceMarks.committee&&raceMarks.pin&&raceMarks.upwind){const mid={lat:(raceMarks.committee.lat+raceMarks.pin.lat)/2,lon:(raceMarks.committee.lon+raceMarks.pin.lon)/2};layers.upwindLeg.setLatLngs([[mid.lat,mid.lon],[raceMarks.upwind.lat,raceMarks.upwind.lon]])}else layers.upwindLeg.setLatLngs([]);const pts=[p,raceMarks.committee,raceMarks.pin,raceMarks.upwind].filter(Boolean).map(x=>[x.lat,x.lon]);if(pts.length&&map._saillabFirstFit!==true){map.fitBounds(pts,{padding:[25,25],maxZoom:16});map._saillabFirstFit=true}}
function refreshMaps(){refreshMap('race');refreshMap('dash')}
function avgWindow(history,seconds){const now=Date.now(),values=history.filter(x=>now-x.t<=seconds*1000).map(x=>x.value).filter(Number.isFinite);return values.length?values.reduce((a,b)=>a+b,0)/values.length:null}
function renderCockpit(){
 const heel=correctedMotion('heel');
 if($('heel'))$('heel').textContent=widgetNumber('live-heel',heel,0);
 const h5=avgWindow(heelHistory,5),h20=avgWindow(heelHistory,20);
 if($('heelAvg5'))$('heelAvg5').textContent=h5==null?'—°':`${widgetNumber('live-heel',h5,1)}°`;
 if($('heelAvg20'))$('heelAvg20').textContent=h20==null?'—°':`${widgetNumber('live-heel',h20,1)}°`;
 if($('heelBubble')){const value=Math.max(-16,Math.min(16,heel??0));$('heelBubble').style.left=`${((value+16)/32)*100}%`; $('heelBubble').classList.toggle('unknown',heel==null)}
 const trim=correctedMotion('pitch'),trim5=avgWindow(pitchHistory,5),trim30=avgWindow(pitchHistory,30);
 if($('trimNow'))$('trimNow').textContent=widgetNumber('trim',trim,1);
 if($('trimAvg5'))$('trimAvg5').textContent=trim5==null?'—°':`${widgetNumber('trim',trim5,1)}°`;
 if($('trimAvg30'))$('trimAvg30').textContent=trim30==null?'—°':`${widgetNumber('trim',trim30,1)}°`;if($('trimBar')){const tv=Math.max(-4,Math.min(4,trim??0));$('trimBar').style.top=`${((4-tv)/8)*100}%`;$('trimBar').classList.toggle('unknown',trim==null)}
 if($('trimCount'))$('trimCount').textContent=motion.enabled?'Motion sensor pitch / longitudinal trim':'Enable motion sensors to read trim';
 if($('sog'))$('sog').textContent=lastFix?.coords.speed==null?'—':widgetNumber('live-sog',lastFix.coords.speed*KNOTS_PER_MS,1);const recentSog=sogHistory.filter(x=>Date.now()-x.t<=20000).map(x=>x.value);if($('avgSpeed'))$('avgSpeed').textContent=recentSog.length?(recentSog.reduce((a,b)=>a+b,0)/recentSog.length).toFixed(1):'—';
 if($('course'))$('course').textContent=widgetNumber('live-course',lastFix?.coords.heading??NaN,0);
 updateWind();updateRaceMetrics();refreshMaps();updateExtraBarValues();renderCustomWidgets();
}
function dashboardConfig(){applyWidgetPrefs();const editor=$('dashboardEditor');if(editor)editor.hidden=true}
function saveDashOrder(){[...$('dashboardGrid').querySelectorAll('[data-widget]')].forEach((el,i)=>{const id=el.dataset.widget;widgetPrefs[id]={...(widgetPrefs[id]||{}),order:i}});localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyWidgetPrefs()}

function updateWind(){
 const portCount=tackSegments.port.length+(activeTack?.type==='port'?1:0),starCount=tackSegments.starboard.length+(activeTack?.type==='starboard'?1:0);
 $('portCount').textContent=portCount;$('starboardCount').textContent=starCount;
 if($('cockpitPortCount'))$('cockpitPortCount').textContent=portCount;if($('cockpitStarboardCount'))$('cockpitStarboardCount').textContent=starCount;
 const p=meanForSegments(tackSegments.port),s=meanForSegments(tackSegments.starboard);
 $('portMean').textContent=`Average course ${p==null?'—':Math.round(p)+'°'}`;$('starboardMean').textContent=`Average course ${s==null?'—':Math.round(s)+'°'}`;
 const courseNow=lastFix?.coords.heading;if($('autoWindQuality'))$('autoWindQuality').textContent=autoWindState.quality;if($('dashWindHeading'))$('dashWindHeading').textContent=courseNow==null?'—°':`${Math.round(courseNow)}°`;
 const est=windEstimate();
 if(!est){$('windDirection').textContent='—';$('leftShift').textContent='—';$('rightShift').textContent='—';$('windBaselineLabel').textContent=windBaseline==null?'Baseline not set':`Baseline ${Math.round(windBaseline)}°`;$('windResult').textContent='Need at least 8 accurate GPS course samples across two stable, distinct courses. The automatic estimate refreshes every 20 seconds.';if($('autoWindQuality'))$('autoWindQuality').textContent=autoWindState.quality;if($('dashWindShift')){$('dashWindShift').textContent='—';$('dashWindLabel').textContent='WAITING FOR GPS';$('dashTrueWindDirection').textContent='—°'}renderWindShiftLeds(null,'unknown');return}
 $('windDirection').textContent=widgetNumber('wind-detail',est.direction,0).padStart(3,'0');$('windNeedle').style.transform=`rotate(${est.direction}deg)`;$('windBaselineLabel').textContent=windBaseline==null?'Baseline not set':`Baseline ${Math.round(windBaseline)}°`;
 const delta=est.delta;const rel=courseNow==null?null:angularDelta(est.direction,courseNow);const tackSide=rel==null||Math.abs(rel)<8?'unknown':rel>0?'starboard':'port';const lift=delta!=null&&tackSide!=='unknown'&&((tackSide==='starboard'&&delta<0)||(tackSide==='port'&&delta>0));$('leftShift').textContent=delta==null?'—':`${delta<0?Math.abs(delta).toFixed(0)+'°':'0°'}`;$('rightShift').textContent=delta==null?'—':`${delta>0?delta.toFixed(0)+'°':'0°'}`;
 $('windResult').textContent=delta==null?'Estimated direction available. Set a baseline to compare future shifts.':delta>0?`RIGHT SHIFT: estimated wind direction has moved ${delta.toFixed(1)}° clockwise from baseline.`:delta<0?`LEFT SHIFT: estimated wind direction has moved ${Math.abs(delta).toFixed(1)}° counter-clockwise from baseline.`:'Wind direction is unchanged from baseline.';if($('autoWindQuality'))$('autoWindQuality').textContent=autoWindState.quality;
 if($('dashWindShift')){$('dashWindShift').textContent=delta==null?'—':`${Math.abs(delta).toFixed(0)}°`;$('dashWindLabel').textContent=delta==null?'SET BASELINE':Math.abs(delta)<1?'NO SHIFT':tackSide==='unknown'?'SHIFT':lift?'LIFT':'HEADER';$('dashTrueWindDirection').textContent=`${Math.round(est.direction)}°`}
 renderWindShiftLeds(delta,tackSide);
}
// Replace the older marker implementation with a segment-aware tack recorder.
function markTack(type){if(!current){toast('Start a session before marking a tack');return}if(activeTack){activeTack.endedAt=new Date().toISOString();activeTack.durationMs=activeTack.samples.length>1?activeTack.samples.at(-1).t-activeTack.samples[0].t:0;activeTack.meanCourse=circularMean(activeTack.courseSamples);if(activeTack.samples.length>=3&&activeTack.courseSamples.length>=2)tackSegments[activeTack.type].push(activeTack);persistWindLegMeans();activeTack=null}activeTack={type,startAt:new Date().toISOString(),samples:[],courseSamples:[],distance:0,last:lastFix?{lat:lastFix.coords.latitude,lon:lastFix.coords.longitude,t:Date.now(),course:lastFix.coords.heading==null?null:lastFix.coords.heading}:null};if(lastFix?.coords.heading!=null)activeTack.courseSamples.push(lastFix.coords.heading);events.push({id:uid(),type:type==='port'?'Port tack start':'Starboard tack start',timestamp:new Date().toISOString(),lat:lastFix?.coords.latitude??null,lon:lastFix?.coords.longitude??null});updateWind();toast(type==='port'?'Port tack leg started':'Starboard tack leg started')}

function applyDashboardLayout(layout){
 const grid=$('dashboardGrid');if(!grid)return;
 const chosen=layout||localStorage.getItem('saillabDashboardLayout')||'race';
 if(layout){Object.keys(widgetPrefs).forEach(id=>{if(widgetPrefs[id])delete widgetPrefs[id].width});}
 grid.dataset.layout=chosen;document.querySelectorAll('[data-layout]').forEach(b=>b.classList.toggle('active',b.dataset.layout===chosen));
 if($('dashboardLayout'))$('dashboardLayout').value=chosen;
 localStorage.setItem('saillabDashboardLayout',chosen);
 const defaultOrder={race:['live-sog','live-course','live-heel','trim','wind-detail'],balanced:['live-sog','live-course','wind-detail','live-heel','trim'],minimal:['live-sog','live-course','live-heel','wind-detail','trim'],big:['live-sog','live-course','live-heel','trim','wind-detail']}[chosen]||['live-sog','live-course','live-heel','trim','wind-detail'];
 const cards=[...grid.querySelectorAll('[data-widget]')];
 if(layout||!cards.some(card=>widgetPrefs[card.dataset.widget]?.order!==undefined)){defaultOrder.forEach((id,i)=>{const card=grid.querySelector(`[data-widget="${id}"]`);if(card){grid.appendChild(card);widgetPrefs[id]={...(widgetPrefs[id]||{}),order:i}}});localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));}
 else cards.sort((a,b)=>(widgetPrefs[a.dataset.widget]?.order??100)-(widgetPrefs[b.dataset.widget]?.order??100)).forEach(card=>grid.appendChild(card));
 grid.querySelectorAll('[data-widget]').forEach(card=>{const id=card.dataset.widget,p=widgetPrefs[id]||{};let full=(chosen==='race'&&id==='wind-detail')||(chosen==='minimal'&&id==='wind-detail');if(p.width&&!layout)full=p.width==='full';card.classList.toggle('widget-full',full);card.classList.toggle('dash-wide',full);card.classList.toggle('widget-hidden',p.hidden===true||(chosen==='minimal'&&id==='trim'&&p.visibilityOverride!==true));});
 if(layout){localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));renderWidgetVisibility();if(document.body.classList.contains('dashboard-editing')||document.body.classList.contains('dashboard-fullscreen'))applyCanvasLayout(true,true);}
 else if(document.body.classList.contains('dashboard-editing')||document.body.classList.contains('dashboard-fullscreen'))applyCanvasLayout(true);
}
function setupLayoutControls(){document.querySelectorAll('[data-layout]').forEach(b=>b.addEventListener('click',()=>applyDashboardLayout(b.dataset.layout)));if($('dashboardLayout'))$('dashboardLayout').addEventListener('change',e=>applyDashboardLayout(e.target.value));}

function persistWindLegMeans(){localStorage.setItem('saillabWindLegMeans',JSON.stringify(tackSegments));updateWind()}
function logTrim(){const v=correctedMotion('pitch');if(v==null){toast('No trim reading yet. Enable motion sensors first.');return}trimReadings.push({t:Date.now(),value:v});trimReadings=trimReadings.filter(x=>Date.now()-x.t<3600000);localStorage.setItem('saillabTrimReadings',JSON.stringify(trimReadings));toast(`Trim sample logged: ${v.toFixed(1)}°`)}
function meanForSegments(segments){const vals=(segments||[]).map(x=>x.meanCourse).filter(Number.isFinite);return vals.length?circularMean(vals):null}
function estimateAutoWind(){
 const now=Date.now();if(autoWindState.attemptedAt&&now-autoWindState.attemptedAt<20000){if(autoWindState.direction!=null)return {direction:autoWindState.direction,delta:windBaseline==null?null:angularDelta(autoWindState.direction,windBaseline),portCourse:autoWindState.portCourse,starboardCourse:autoWindState.starboardCourse,automatic:true};return null}autoWindState.attemptedAt=now;autoWindState.direction=null;const data=courseHistory.filter(x=>Number.isFinite(x.course)&&now-x.t<=180000&&(x.accuracy==null||x.accuracy<35));
 const courses=data.map(x=>x.course);if(courses.length<8){autoWindState.quality=`Collecting GPS courses (${courses.length}/8)`;return null}
 // Seed two circular clusters from the pair with the largest useful tack separation.
 let seedA=null,seedB=null,best=0;for(let i=0;i<courses.length;i++)for(let j=i+1;j<courses.length;j++){const d=Math.abs(angularDelta(courses[i],courses[j]));if(d>45&&d<150&&d>best){best=d;seedA=courses[i];seedB=courses[j]}}
 if(seedA===null){autoWindState.quality='Need two distinct, steady courses on opposite tacks';return null}
 let a=seedA,b=seedB,ca=[],cb=[];for(let iter=0;iter<5;iter++){ca=[];cb=[];courses.forEach(c=>Math.abs(angularDelta(c,a))<=Math.abs(angularDelta(c,b))?ca.push(c):cb.push(c));if(ca.length)circularMean(ca)!=null&&(a=circularMean(ca));if(cb.length)circularMean(cb)!=null&&(b=circularMean(cb))}
 const separation=Math.abs(angularDelta(a,b));if(ca.length<3||cb.length<3||separation<45||separation>150){autoWindState.quality='Waiting for stable legs on opposite tacks';return null}
 // Approximate upwind wind-from direction by the bisector of the two upwind courses.
 const direction=circularMean([a,b]);if(direction==null)return null;
 autoWindState={direction,portCourse:a,starboardCourse:b,quality:`Auto · ${ca.length}+${cb.length} GPS samples · refreshed ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`,updatedAt:now,attemptedAt:now};
 if(windBaseline==null){windBaseline=direction;localStorage.setItem('saillabWindBaseline',JSON.stringify(windBaseline))}
 return {direction,delta:angularDelta(direction,windBaseline),portCourse:a,starboardCourse:b,automatic:true};
}
function windEstimate(){return estimateAutoWind()||(()=>{const p=meanForSegments(tackSegments.port),s=meanForSegments(tackSegments.starboard);if(p==null||s==null)return null;const direction=circularMean([p,s]);return direction==null?null:{direction,delta:windBaseline==null?null:angularDelta(direction,windBaseline),portCourse:p,starboardCourse:s}})()}
function renderWindShiftLeds(delta,tackSide){const host=$('windShiftLeds');if(!host)return;host.innerHTML='';const lift=delta!=null&&tackSide!=='unknown'&&((tackSide==='starboard'&&delta<0)||(tackSide==='port'&&delta>0));for(let i=0;i<8;i++){const led=document.createElement('span');led.className='wind-led';if(delta!=null&&Math.abs(delta)>=1&&tackSide!=='unknown'){const count=Math.min(4,Math.max(1,Math.round(Math.abs(delta)/2)));if(lift&&i<count)led.classList.add('left','on');if(!lift&&i>=8-count)led.classList.add('right','on')}host.append(led)}}
function showFlagEditor(){if(locked)unlockScreen();$('flagEditor').hidden=false;$('flagEditor').scrollIntoView({behavior:'smooth',block:'nearest'});renderFlagList()}
function renderFlagList(){const host=$('flagList');if(!host)return;host.innerHTML='';(savedFlags||[]).slice().reverse().forEach(e=>{const row=document.createElement('div');row.className='flag-row';const meta=document.createElement('div');meta.innerHTML=`<strong>${new Date(e.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</strong><div class="muted small"></div>`;meta.querySelector('div').textContent=e.note||'Flag';row.append(meta);if(e.photo){const img=document.createElement('img');img.src=e.photo;img.alt='Flag photo';row.append(img)}host.append(row)})}
async function saveFlag(){const ev={id:uid(),type:'Flag',timestamp:new Date().toISOString(),lat:lastFix?.coords.latitude??null,lon:lastFix?.coords.longitude??null,note:$('flagNote').value.trim(),photo:flagPhotoData};savedFlags.push(ev);localStorage.setItem('saillabFlags',JSON.stringify(savedFlags));events.push(ev);if(current)await saveCurrent();$('flagNote').value='';$('flagPhotoInput').value='';flagPhotoData=null;$('flagPhotoPreview').innerHTML='';renderFlagList();$('flagEditor').hidden=true;toast('Flag saved with timestamp')}
function initFlagControls(){if($('flagMomentBtn'))$('flagMomentBtn').onclick=showFlagEditor;$('closeFlagEditor').onclick=()=>$('flagEditor').hidden=true;$('saveFlagBtn').onclick=()=>saveFlag().catch(e=>toast('Could not save flag: '+e.message));$('flagPhotoInput').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{flagPhotoData=await compressPhoto(f);$('flagPhotoPreview').innerHTML='';const img=document.createElement('img');img.src=flagPhotoData;img.alt='Flag preview';$('flagPhotoPreview').append(img)}catch(err){toast('Could not load photo')}}}
function initRaceFeature(){updateRaceEndpoints();$('gunSeconds').value=localStorage.getItem('saillabGunSeconds')||'300';$('pingCommittee').onclick=()=>pingEndpoint('committee');$('pingPin').onclick=()=>pingEndpoint('pin');$('pingUpwind').onclick=()=>pingEndpoint('upwind');$('gunStart').onclick=startGunCountdown;$('gunSync').onclick=syncGunToMinute;$('gunMinusMinute').onclick=()=>adjustGunMinutes(-1);$('gunPlusMinute').onclick=()=>adjustGunMinutes(1);$('gunReset').onclick=resetGunCountdown;$('centerRaceMap').onclick=()=>{if(raceMap){const pts=[currentPoint(),raceMarks.committee,raceMarks.pin,raceMarks.upwind].filter(Boolean).map(x=>[x.lat,x.lon]);if(pts.length)raceMap.fitBounds(pts,{padding:[25,25],maxZoom:16})}};$('dashboardRaceBtn')&&($('dashboardRaceBtn').onclick=()=>showView('race'));$('widgetSelect').onchange=loadWidgetForm;$('widgetWidth').onchange=saveSelectedWidget;$('widgetFont').onchange=saveSelectedWidget;$('widgetBg').onchange=saveSelectedWidget;$('widgetColor').onchange=saveSelectedWidget;$('widgetUp').onclick=()=>moveWidget(-1);$('widgetDown').onclick=()=>moveWidget(1);$('widgetHide').onclick=()=>{const id=$('widgetSelect').value;widgetPrefs[id]={...(widgetPrefs[id]||{}),hidden:!(widgetPrefs[id]?.hidden)};localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));applyWidgetPrefs()};$('widgetReset').onclick=()=>{widgetPrefs={};localStorage.removeItem('saillabWidgetPrefs');applyWidgetPrefs();applyDashboardLayout('race');toast('Dashboard reset')};$('logTrim').onclick=logTrim;$('setWindBaseline').onclick=()=>{const w=windEstimate();if(!w){toast('Need more stable GPS course data first');return}windBaseline=w.direction;localStorage.setItem('saillabWindBaseline',JSON.stringify(windBaseline));updateWind();renderCockpit();toast('Wind baseline set')};$('resetWindData').onclick=()=>{if(!confirm('Clear saved port/starboard legs and the wind-shift baseline?'))return;windBaseline=null;tackSegments={port:[],starboard:[]};localStorage.removeItem('saillabWindBaseline');localStorage.removeItem('saillabWindLegMeans');updateWind();renderCockpit();toast('Wind legs and baseline cleared')};
 $('portTack').onclick=()=>{markTack('port')};$('starboardTack').onclick=()=>{markTack('starboard')};if($('cockpitPortTack'))$('cockpitPortTack').onclick=()=>markTack('port');if($('cockpitStarboardTack'))$('cockpitStarboardTack').onclick=()=>markTack('starboard');
 initFlagControls();initCustomWidgets();dashboardConfig();setupLayoutControls();setupEditorControls();applyDashboardLayout();setInterval(renderCustomWidgets,1000);
}
const originalShowView=showView;
showView=function(name){originalShowView(name);if(name==='race'){if(!raceMap&&typeof L!=='undefined')initMap('raceMap','race');setTimeout(()=>raceMap?.invalidateSize(),80);refreshMap('race')}if(name==='cockpit'){if(!dashMap&&typeof L!=='undefined')initMap('dashboardMap','dash');setTimeout(()=>dashMap?.invalidateSize(),80);refreshMap('dash');renderCockpit()}if(name==='map'){initWeatherMap();setTimeout(()=>weatherRaceMap?.invalidateSize(),120);refreshWeatherRaceMap();updateForecastFrame()}};
window.addEventListener('resize',()=>{if($('view-cockpit')?.classList.contains('active')){dashMap?.invalidateSize();renderCockpit()}if($('view-race')?.classList.contains('active'))raceMap?.invalidateSize()});
const previousRequestGps=requestGps;
requestGps=function(){previousRequestGps();if($('settingsGpsToggle'))$('settingsGpsToggle').textContent='Disable GPS';setTimeout(()=>{updateRaceMetrics();renderCockpit()},300)};
const previousUpdateStats=updateStats;
updateStats=function(){previousUpdateStats();renderCockpit()};
const previousOrientationDisplay=updateMotionDisplay;
updateMotionDisplay=function(){previousOrientationDisplay();renderCockpit()};
const previousApplyPrefs=applyWidgetPrefs;
applyWidgetPrefs=function(){previousApplyPrefs();applyDashboardLayout();renderCockpit()};
initRaceFeature();renderFlagList();if(typeof L!=='undefined')initMap('dashboardMap','dash');updateWind();updateRaceMetrics();renderCockpit();autoWindTimer=setInterval(()=>{if(lastFix){const est=estimateAutoWind();if(est)updateWind();renderCockpit()}},20000);setTimeout(()=>dashMap?.invalidateSize(),100);

/* SailLab v13: local profiles, dashboard pages, device geometry and weather/race marks map. */
let saillabAuthUser = null;
const originalDbPutForProfiles=dbPut;dbPut=async function(obj){const record=saillabAuthUser&&!obj.ownerId?{...obj,ownerId:saillabAuthUser.id}:obj;return originalDbPutForProfiles(record)};
const AUTH_USERS_KEY='saillabLocalProfilesV1';
const DEVICE_KEY='saillabDeviceConfigV1';
function readLocalUsers(){try{return JSON.parse(localStorage.getItem(AUTH_USERS_KEY)||'[]')}catch(_){return []}}
function writeLocalUsers(users){localStorage.setItem(AUTH_USERS_KEY,JSON.stringify(users))}
function safeText(s){return String(s||'').trim().slice(0,28)}
async function passwordDigest(password,salt){const raw=`${salt}:${password}`;if(window.crypto?.subtle){const bytes=new TextEncoder().encode(raw);const hash=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')}let h=2166136261;for(let i=0;i<raw.length;i++){h^=raw.charCodeAt(i);h=Math.imul(h,16777619)}return `fallback-${(h>>>0).toString(16)}`}
function setLoginError(msg){$('loginError').textContent=msg||''}
function refreshLoginProfiles(){const users=readLocalUsers(),wrap=$('loginExistingWrap'),sel=$('loginProfileSelect');wrap.hidden=!users.length;sel.innerHTML='';users.forEach(u=>{const o=document.createElement('option');o.value=u.id;o.textContent=u.name;sel.append(o)});if(users.length)$('loginPassword').value=''}
function profileStateKey(kind,userId=saillabAuthUser?.id){return userId?`saillabProfileState_${userId}_${kind}`:null}
function saveProfileState(userId=saillabAuthUser?.id){if(!userId)return;localStorage.setItem(profileStateKey('widgets',userId),JSON.stringify(widgetPrefs||{}));localStorage.setItem(profileStateKey('customWidgets',userId),JSON.stringify(customWidgetDefs||[]));localStorage.setItem(profileStateKey('layout',userId),localStorage.getItem('saillabDashboardLayout')||'race');localStorage.setItem(profileStateKey('theme',userId),$('dashboardTheme')?.value||localStorage.getItem('saillabTheme')||'blue')}
function loadProfileState(user){const wp=localStorage.getItem(profileStateKey('widgets',user.id)),cw=localStorage.getItem(profileStateKey('customWidgets',user.id)),lay=localStorage.getItem(profileStateKey('layout',user.id)),th=localStorage.getItem(profileStateKey('theme',user.id));if(wp!==null)widgetPrefs=JSON.parse(wp||'{}');if(cw!==null)customWidgetDefs=JSON.parse(cw||'[]');if(lay)localStorage.setItem('saillabDashboardLayout',lay);if(th){localStorage.setItem('saillabTheme',th);if($('dashboardTheme'))$('dashboardTheme').value=th;applyTheme(th)}localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));localStorage.setItem('saillabCustomWidgets',JSON.stringify(customWidgetDefs));if(wp===null&&cw===null)saveProfileState(user.id);initCustomWidgets();syncEditorWidgetOptions();applyWidgetPrefs();applyDashboardLayout(localStorage.getItem('saillabDashboardLayout')||'race')}
function getDeviceConfig(){try{return JSON.parse(localStorage.getItem(DEVICE_KEY)||'null')}catch(_){return null}}
function applyDeviceConfig(cfg){if(!cfg)return;let w=Math.max(240,Number(cfg.width)||384),h=Math.max(240,Number(cfg.height)||854);if(cfg.orientation==='landscape'&&h>w)[w,h]=[h,w];if(cfg.orientation!=='landscape'&&w>h)[w,h]=[h,w];document.documentElement.style.setProperty('--device-aspect',`${w} / ${h}`);document.documentElement.style.setProperty('--device-frame-width',cfg.orientation==='landscape'?'min(100%, 640px)':'min(100%, 330px)');const label=$('phonePreviewLabel');if(label)label.textContent=`PHONE CANVAS · ${cfg.label||'CUSTOM DEVICE'} · ${cfg.orientation==='landscape'?'LANDSCAPE':'PORTRAIT'} · ${w}×${h}`;document.body.dataset.deviceOrientation=cfg.orientation||'portrait';}
function showDeviceSetup(){const cfg=getDeviceConfig()||{preset:'s21ultra',label:'Samsung S21 Ultra',width:384,height:854,orientation:'portrait'};$('devicePreset').value=cfg.preset||'custom';$('deviceWidth').value=cfg.width||384;$('deviceHeight').value=cfg.height||854;$('deviceOrientation').value=cfg.orientation||'portrait';$('deviceSetupOverlay').hidden=false}
function updateDevicePreset(){const presets={s21ultra:{label:'Samsung S21 Ultra',width:384,height:854},s21:{label:'Samsung S21',width:360,height:800},iphone:{label:'iPhone',width:390,height:844},tablet:{label:'Tablet',width:800,height:1280},custom:{label:'Custom device',width:Number($('deviceWidth').value)||384,height:Number($('deviceHeight').value)||854}};const v=$('devicePreset').value;if(v==='custom')return;const p=presets[v];$('deviceWidth').value=p.width;$('deviceHeight').value=p.height}
function saveDeviceSetup(){const preset=$('devicePreset').value,orientation=$('deviceOrientation').value;const labels={s21ultra:'Samsung S21 Ultra',s21:'Samsung S21',iphone:'iPhone',tablet:'Tablet',custom:'Custom device'};const cfg={preset,label:labels[preset],width:Math.max(240,Math.min(1800,Number($('deviceWidth').value)||384)),height:Math.max(240,Math.min(2400,Number($('deviceHeight').value)||854)),orientation};localStorage.setItem(DEVICE_KEY,JSON.stringify(cfg));applyDeviceConfig(cfg);$('deviceSetupOverlay').hidden=true;applyCanvasLayout(document.body.classList.contains('dashboard-editing')||document.body.classList.contains('dashboard-fullscreen'));toast(`Display configured: ${cfg.label} · ${orientation}`)}
function currentDashboardSnapshot(name){return {id:uid(),name:safeText(name)||`Dashboard ${new Date().toLocaleDateString()}`,createdAt:new Date().toISOString(),layout:localStorage.getItem('saillabDashboardLayout')||'race',theme:$('dashboardTheme')?.value||'blue',widgetPrefs:JSON.parse(JSON.stringify(widgetPrefs||{})),customWidgetDefs:JSON.parse(JSON.stringify(customWidgetDefs||[])),device:getDeviceConfig()}}
function dashboardPagesKey(){return `saillabDashboardPages_${saillabAuthUser?.id||'guest'}`}
function readDashboardPages(){try{return JSON.parse(localStorage.getItem(dashboardPagesKey())||'[]')}catch(_){return []}}
function writeDashboardPages(pages){localStorage.setItem(dashboardPagesKey(),JSON.stringify(pages));renderDashboardPages()}
function renderDashboardPages(){const host=$('dashboardPageList');if(!host)return;const pages=readDashboardPages();$('dashboardPageCount').textContent=`${pages.length} / 10`;host.innerHTML='';if(!pages.length){host.innerHTML='<p class="muted small">No saved dashboard pages yet.</p>';return}pages.forEach(page=>{const row=document.createElement('div');row.className='dashboard-page-row';const info=document.createElement('div');const name=document.createElement('strong');name.textContent=page.name;const meta=document.createElement('small');meta.textContent=`${page.layout||'race'} · ${new Date(page.createdAt).toLocaleDateString()}`;info.append(name,meta);const actions=document.createElement('div');actions.className='dashboard-page-row-actions';const load=document.createElement('button');load.type='button';load.className='secondary compact';load.textContent='Load';load.onclick=()=>loadDashboardPage(page.id);const del=document.createElement('button');del.type='button';del.className='secondary compact';del.textContent='Delete';del.onclick=()=>{if(confirm(`Delete dashboard “${page.name}”?`))writeDashboardPages(readDashboardPages().filter(p=>p.id!==page.id))};actions.append(load,del);row.append(info,actions);host.append(row)})}
function saveDashboardPage(){saveProfileState();const pages=readDashboardPages(),name=safeText($('dashboardPageName').value);if(pages.length>=10){toast('Maximum 10 saved dashboard pages. Delete one before saving another.');return}if(!name){toast('Enter a name for this dashboard page');$('dashboardPageName').focus();return}pages.push(currentDashboardSnapshot(name));writeDashboardPages(pages);$('dashboardPageName').value='';toast('Dashboard page saved to this profile')}
function loadDashboardPage(id){const page=readDashboardPages().find(p=>p.id===id);if(!page)return;widgetPrefs=JSON.parse(JSON.stringify(page.widgetPrefs||{}));customWidgetDefs=JSON.parse(JSON.stringify(page.customWidgetDefs||[]));localStorage.setItem('saillabWidgetPrefs',JSON.stringify(widgetPrefs));localStorage.setItem('saillabCustomWidgets',JSON.stringify(customWidgetDefs));if(page.layout){localStorage.setItem('saillabDashboardLayout',page.layout);$('dashboardLayout').value=page.layout;applyDashboardLayout(page.layout)}if(page.theme){$('dashboardTheme').value=page.theme;applyDashboardTheme(page.theme)}initCustomWidgets();syncEditorWidgetOptions();applyWidgetPrefs();applyCanvasLayout(document.body.classList.contains('dashboard-editing')||document.body.classList.contains('dashboard-fullscreen'));renderWidgetVisibility();loadEditorWidgetForm();toast(`Loaded dashboard: ${page.name}`)}
function applyDashboardTheme(theme){applyTheme(theme);localStorage.setItem('saillabDashboardTheme',theme)}
function loginUser(user){saillabAuthUser=user;loadProfileState(user);sessionStorage.setItem('saillabActiveProfile',user.id);document.body.classList.remove('not-authenticated');$('loginGate').hidden=true;$('activeProfileBadge').hidden=false;$('activeProfileBadge').textContent=user.name;$('logoutBtn').hidden=false;$('changeDeviceBtn').hidden=false;const allPromise=assignLegacySessions(user.id);applyDeviceConfig(getDeviceConfig());refreshLoginProfiles();renderDashboardPages();if(!getDeviceConfig())showDeviceSetup();else{allPromise.then(()=>renderSessions()).catch(()=>{});toast(`Welcome, ${user.name}`)}}
async function registerLocalProfile(){const name=safeText($('registerName').value),password=$('registerPassword').value;if(name.length<2){setLoginError('Enter a profile name with at least 2 characters.');return}if(password.length<4){setLoginError('Use a password with at least 4 characters.');return}const users=readLocalUsers();if(users.some(u=>u.name.toLowerCase()===name.toLowerCase())){setLoginError('That profile name already exists on this device.');return}const id=uid(),salt=uid(),hash=await passwordDigest(password,salt),user={id,name,salt,hash,createdAt:new Date().toISOString()};users.push(user);writeLocalUsers(users);$('registerName').value='';$('registerPassword').value='';setLoginError('');loginUser(user)}
async function submitLocalLogin(){const id=$('loginProfileSelect').value,password=$('loginPassword').value,user=readLocalUsers().find(u=>u.id===id);if(!user){setLoginError('Choose a profile first.');return}const hash=await passwordDigest(password,user.salt);if(hash!==user.hash){setLoginError('Incorrect password.');return}setLoginError('');loginUser(user)}
async function logoutLocalProfile(){saveProfileState();if(current&&['recording','paused'].includes(current.status)){if(!confirm('A session is active. Save it and sign out?'))return;await saveCurrent().catch(()=>{});if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}current=null;samples=[];events=[];sessionStartMs=null;paused=false}sessionStorage.removeItem('saillabActiveProfile');saillabAuthUser=null;document.body.classList.add('not-authenticated');$('loginGate').hidden=false;$('activeProfileBadge').hidden=true;$('logoutBtn').hidden=true;$('changeDeviceBtn').hidden=true;refreshLoginProfiles();setLoginError('')}
async function assignLegacySessions(userId){for(let i=0;i<40&&!db;i++)await new Promise(r=>setTimeout(r,100));if(!db)return;const all=await dbAll();await Promise.all(all.filter(s=>!s.ownerId).map(s=>dbPut({...s,ownerId:userId})));}
function initLocalAuth(){const users=readLocalUsers();refreshLoginProfiles();$('registerSubmit').onclick=registerLocalProfile;$('loginSubmit').onclick=submitLocalLogin;$('loginPassword').addEventListener('keydown',e=>{if(e.key==='Enter')submitLocalLogin()});$('registerPassword').addEventListener('keydown',e=>{if(e.key==='Enter')registerLocalProfile()});$('logoutBtn').onclick=logoutLocalProfile;$('changeDeviceBtn').onclick=showDeviceSetup;$('configureDeviceFromDashboard').onclick=showDeviceSetup;$('devicePreset').onchange=updateDevicePreset;$('deviceSetupSave').onclick=saveDeviceSetup;$('deviceSetupCancel').onclick=()=>{if(!getDeviceConfig()){toast('Choose a device configuration to continue');return}$('deviceSetupOverlay').hidden=true};$('saveDashboardPage').onclick=saveDashboardPage;
 if(users.length){const active=sessionStorage.getItem('saillabActiveProfile'),user=users.find(u=>u.id===active);if(user){loginUser(user);return}}
 document.body.classList.add('not-authenticated');$('loginGate').hidden=false;
}

/* Weather model map: own Leaflet layer keeps all pinged marks visible. */
function weatherCenter(){const pts=[currentPoint(),raceMarks.committee,raceMarks.pin,raceMarks.upwind].filter(Boolean);if(pts.length){return {lat:pts.reduce((a,p)=>a+p.lat,0)/pts.length,lon:pts.reduce((a,p)=>a+p.lon,0)/pts.length}}return {lat:41,lon:9}}
function initWeatherMap(){if(weatherRaceMap||typeof L==='undefined'||!$('weatherRaceMap'))return;const c=weatherCenter();weatherRaceMap=L.map('weatherRaceMap').setView([c.lat,c.lon],10);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(weatherRaceMap);weatherRaceLayers.boat=L.circleMarker([c.lat,c.lon],{radius:7,color:'#54e0c0',fillColor:'#54e0c0',fillOpacity:1,weight:2}).bindTooltip('Your boat').addTo(weatherRaceMap);weatherRaceLayers.committee=L.circleMarker([c.lat,c.lon],{radius:7,color:'#a78bfa',fillColor:'#a78bfa',fillOpacity:1,weight:2}).bindTooltip('Committee boat').addTo(weatherRaceMap);weatherRaceLayers.pin=L.circleMarker([c.lat,c.lon],{radius:7,color:'#ffb454',fillColor:'#ffb454',fillOpacity:1,weight:2}).bindTooltip('Pin').addTo(weatherRaceMap);weatherRaceLayers.upwind=L.circleMarker([c.lat,c.lon],{radius:7,color:'#7be0aa',fillColor:'#7be0aa',fillOpacity:1,weight:2}).bindTooltip('Upwind mark').addTo(weatherRaceMap);weatherRaceLayers.line=L.polyline([],{color:'#f1f6fa',weight:3,dashArray:'7 6'}).addTo(weatherRaceMap);weatherRaceLayers.upwindLeg=L.polyline([],{color:'#5ce0bd',weight:2,dashArray:'5 5'}).addTo(weatherRaceMap);refreshWeatherRaceMap()}
function refreshWeatherRaceMap(){if(!weatherRaceMap)return;const p=currentPoint();for(const key of ['boat','committee','pin','upwind']){const val=key==='boat'?p:raceMarks[key];const layer=weatherRaceLayers[key];if(val){layer.setLatLng([val.lat,val.lon]);layer.setStyle({opacity:1,fillOpacity:1})}else layer.setStyle({opacity:0,fillOpacity:0})}if(raceMarks.committee&&raceMarks.pin)weatherRaceLayers.line.setLatLngs([[raceMarks.committee.lat,raceMarks.committee.lon],[raceMarks.pin.lat,raceMarks.pin.lon]]);else weatherRaceLayers.line.setLatLngs([]);if(raceMarks.committee&&raceMarks.pin&&raceMarks.upwind){const m={lat:(raceMarks.committee.lat+raceMarks.pin.lat)/2,lon:(raceMarks.committee.lon+raceMarks.pin.lon)/2};weatherRaceLayers.upwindLeg.setLatLngs([[m.lat,m.lon],[raceMarks.upwind.lat,raceMarks.upwind.lon]])}else weatherRaceLayers.upwindLeg.setLatLngs([]);const pts=[p,raceMarks.committee,raceMarks.pin,raceMarks.upwind].filter(Boolean).map(x=>[x.lat,x.lon]);if(pts.length&&!weatherRaceMap._saillabFirstFit){weatherRaceMap.fitBounds(pts,{padding:[25,25],maxZoom:15});weatherRaceMap._saillabFirstFit=true;}}
function updateForecastFrame(){const model=$('forecastModel')?.value||'ecmwf',c=weatherCenter(),frame=$('forecastFrame');if(!frame)return;if(model==='predictwind'){frame.style.display='none';frame.removeAttribute('src');return}frame.style.display='block';frame.src=`https://embed.windy.com/embed2.html?lat=${c.lat.toFixed(4)}&lon=${c.lon.toFixed(4)}&detailLat=${c.lat.toFixed(4)}&detailLon=${c.lon.toFixed(4)}&width=650&height=450&zoom=8&level=surface&overlay=wind&product=${encodeURIComponent(model)}&menu=&message=true&marker=true&calendar=now&pressure=true&type=map&location=coordinates&detail=&metricWind=kt&metricTemp=%C2%B0C`}
function openSelectedForecast(){const model=$('forecastModel').value,c=weatherCenter();if(model==='predictwind'){window.open(`https://www.predictwind.com/`, '_blank','noopener');return}window.open(`https://www.windy.com/${c.lat.toFixed(3)}/${c.lon.toFixed(3)}?${model},${c.lat.toFixed(3)},${c.lon.toFixed(3)},8`,'_blank','noopener')}
window.addEventListener('pagehide',()=>saveProfileState());window.addEventListener('beforeunload',()=>saveProfileState());
$('backupBtn').onclick=async()=>{const all=await dbAll();const mine=all.filter(s=>!saillabAuthUser||s.ownerId===saillabAuthUser.id||!s.ownerId);download('saillab-backup.json',JSON.stringify(mine,null,2),'application/json')};
$('forecastModel').addEventListener('change',updateForecastFrame);$('openForecastModel').onclick=openSelectedForecast;$('centerWeatherMap').onclick=()=>{initWeatherMap();const c=weatherCenter();weatherRaceMap?.setView([c.lat,c.lon],13)};$('refreshWeatherMarks').onclick=()=>{refreshWeatherRaceMap();updateForecastFrame();weatherRaceMap?.invalidateSize();toast('Race marks refreshed')};
const priorSaveRaceMarks=saveRaceMarks;saveRaceMarks=function(){priorSaveRaceMarks();refreshWeatherRaceMap();updateForecastFrame()};
const priorRenderCockpit=renderCockpit;renderCockpit=function(){priorRenderCockpit();refreshWeatherRaceMap()};
const priorLockScreen=lockScreen;lockScreen=async function(){await priorLockScreen();const cfg=getDeviceConfig();try{if(cfg&&screen.orientation?.lock)await screen.orientation.lock(cfg.orientation==='landscape'?'landscape':'portrait')}catch(_){/* Device/browser may not permit orientation lock. */}};
const priorUnlockScreen=unlockScreen;unlockScreen=function(){priorUnlockScreen();try{screen.orientation?.unlock?.()}catch(_){}}
initLocalAuth();
