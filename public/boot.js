// Avoid standalone WebKit's viewport-fit=cover clipping of fixed root layouts.
// Let iOS inset the web viewport itself; CSS safe-area values reflect that mode.
// Run before the first app layout; native iOS keeps its existing cover policy.
if(/iPhone|iPod/i.test(navigator.userAgent)&&!/TeamRoom-iOS\//i.test(navigator.userAgent)&&(navigator.standalone===true||matchMedia('(display-mode:standalone)').matches)){
 const viewport=document.querySelector('meta[name=viewport]');
 if(viewport)viewport.content=viewport.content.replace(/viewport-fit\s*=\s*cover/i,'viewport-fit=auto');
}
window.teamRoomBoot=fetch('/api/state',{signal:AbortSignal.timeout(15000)});window.teamRoomBoot.catch(()=>{});
