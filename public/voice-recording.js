// Every preview is a complete WAV, including on Safari. MediaRecorder timeslices
// are not standalone audio files and cannot safely be sent to Whisper separately.
export class DraftRecording {
 constructor({data,ended}){this.onData=data;this.onEnded=ended;this.parts=[];this.length=0;this.closed=false;}
 get supported(){return Boolean(window.AudioContext&&window.AudioWorkletNode);}
 async start(){
  this.context=new AudioContext();const resume=this.context.resume().catch(()=>{});
  try{
   this.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
   if(this.closed){this.stream.getTracks().forEach(t=>t.stop());return;}
   await resume;await this.context.audioWorklet.addModule('/voice-capture.js');if(this.closed)return;
   this.source=this.context.createMediaStreamSource(this.stream);this.node=new AudioWorkletNode(this.context,'teamroom-voice-capture');
   this.node.port.onmessage=event=>{if(this.closed)return;const {samples,ended}=event.data;if(samples){this.parts.push(samples);this.length+=samples.length;this.onData(this);}if(ended){this.release();this.onEnded(this);}};
   this.node.onprocessorerror=()=>this.stop();this.source.connect(this.node);this.node.connect(this.context.destination);
   this.stream.getAudioTracks().forEach(track=>track.addEventListener('ended',()=>this.stop(),{once:true}));
   this.timer=setTimeout(()=>this.stop(),121000);
  }catch(error){this.cancel();throw error;}
 }
 wav(start=0,end=this.length){
  const length=Math.max(0,end-start),buffer=new ArrayBuffer(44+length*2),view=new DataView(buffer),write=(at,value)=>{for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i))};
  write(0,'RIFF');view.setUint32(4,36+length*2,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,length*2,true);
  let offset=0,output=44;for(const part of this.parts){const from=Math.max(0,start-offset),until=Math.min(part.length,end-offset);for(let i=from;i<until;i++){const value=Math.max(-1,Math.min(1,part[i]));view.setInt16(output,value<0?value*32768:value*32767,true);output+=2;}offset+=part.length;if(offset>=end)break;}
  return new Blob([buffer],{type:'audio/wav'});
 }
 stop(){if(this.closed||this.stopping)return;this.stopping=true;clearTimeout(this.timer);if(this.node){this.node.port.postMessage('stop');this.flushTimer=setTimeout(()=>{if(!this.closed){this.release();this.onEnded(this)}},1500);}else{this.release();this.onEnded(this);}this.stream?.getTracks().forEach(t=>t.stop());}
 release(){this.closed=true;clearTimeout(this.timer);clearTimeout(this.flushTimer);this.source?.disconnect();this.node?.disconnect();if(this.node)this.node.port.onmessage=null;this.stream?.getTracks().forEach(t=>t.stop());void this.context?.close().catch(()=>{});}
 cancel(){this.release();this.parts=[];this.length=0;}
}
