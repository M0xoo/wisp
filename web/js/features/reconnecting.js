// The live stream is down and hasn't come back: nothing on the page can tell a person that wisp has
// gone (a task's timer keeps counting), so one line says so. It waits, so a blip shows nothing.
export const WAIT = 4000;

let timer = null;

const show = (on) => {
  document.body.classList.toggle('stream-down', on);
  document.getElementById('reconnecting').hidden = !on;
};

export function streamDown() {
  if (timer !== null) return; // every failed retry calls this: the wait runs from the first
  timer = setTimeout(() => show(true), WAIT);
}

export function streamUp() {
  clearTimeout(timer);
  timer = null;
  show(false);
}
