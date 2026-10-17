// Runs off the UI thread. Continuous mono capture resampled to 16 kHz;
// outputs remain silent so microphone audio never feeds back to the speaker.
class VoiceCapture extends AudioWorkletProcessor {
 constructor(){super();this.samples=new Float32Array(4096);this.length=0;this.sum=0;this.weight=0;this.ratio=sampleRate/16000;this.count=0;this.active=true;this.port.onmessage=event=>{if(event.data==='stop')this.finish()};}
 emit(){if(!this.length)return;const data=this.samples.slice(0,this.length);this.port.postMessage({samples:data},[data.buffer]);this.length=0;}
 finish(){if(!this.active)return;this.active=false;this.emit();this.port.postMessage({ended:true});}
 process(inputs){
  if(!this.active)return false;
  const channel=inputs[0]?.[0];if(!channel)return true;
  for(const value of channel){let left=1;while(left>1e-8){const take=Math.min(left,this.ratio-this.weight);this.sum+=value*take;this.weight+=take;left-=take;if(this.weight>=this.ratio-1e-8){this.samples[this.length++]=this.sum/this.weight;this.sum=0;this.weight=0;this.count++;if(this.length===this.samples.length)this.emit();if(this.count>=16000*120){this.finish();return false;}}}}
  return true;
 }
}
registerProcessor('teamroom-voice-capture',VoiceCapture);
