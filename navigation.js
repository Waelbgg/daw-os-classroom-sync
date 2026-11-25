(() => {
  "use strict";
  function revealHash(){
    const target = document.getElementById(location.hash.slice(1));
    if(!target) return;
    const details = target.closest("details");
    if(details && !details.open){
      details.open = true;
      requestAnimationFrame(() => target.scrollIntoView({block:"start"}));
    }
  }
  document.querySelectorAll('a[href^="#daw-"]').forEach(link => {
    link.addEventListener("click", () => {
      const target = document.getElementById(link.hash.slice(1));
      const details = target?.closest("details");
      if(details) details.open = true;
    });
  });
  window.addEventListener("hashchange",revealHash);
  revealHash();
})();
