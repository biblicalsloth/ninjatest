// Shared by components/side-nav.tsx (client) and app/layout.tsx (server). Lives
// outside the "use client" module because a server component importing a
// string from one gets a client reference, not the string.
export const SIDENAV_STORE_KEY = "sidenav-collapsed";
export const SIDENAV_COLLAPSED_ATTR = "data-nav-collapsed";

// Inline in <head>, before first paint: marks <html> if the user collapsed the
// sidebar, so globals.css lays the page out collapsed from frame one.
export const SIDENAV_INIT_SCRIPT = `try{if(localStorage.getItem("${SIDENAV_STORE_KEY}")==="1")document.documentElement.setAttribute("${SIDENAV_COLLAPSED_ATTR}","")}catch(e){}`;
