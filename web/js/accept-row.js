// Whether Settings hides Accept tasks from channels. A box has no tunnel, so there it means nothing.
// The phone app can't turn it on (only the computer can), but it's where you'd turn it off from, so it
// shows there while it's on. seen: it was on since Settings opened, so the row stays put once switched off.
export const acceptRowHidden = ({ mobile, box, on, seen = false }) => box || (mobile && !on && !seen);
