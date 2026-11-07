// What a desktop app does on Windows and Tauri doesn't by itself. Numbers in qa/scenarios/desktop.md.

use tauri::image::Image;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2ContextMenuItemCollection, ICoreWebView2_11, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN};
use webview2_com::{take_pwstr, AcceleratorKeyPressedEventHandler, ContextMenuRequestedEventHandler};
use windows::core::{Interface, PWSTR};

// wisp's width and height are the whole window, centred, stopping at the screen's edges.
// Tauri's are the page inside the frame, wherever Windows puts it: on a 1366×768 laptop that's past
// the right edge and under the taskbar.
pub fn place(w: &WebviewWindow, width: f64, height: f64) -> tauri::Result<()> {
  let Some(monitor) = w.current_monitor()? else { return Ok(()) };
  let (area, scale) = (monitor.work_area(), monitor.scale_factor());
  let (outer, inner) = (w.outer_size()?, w.inner_size()?);
  let (full_w, full_h) = (((width * scale) as u32).min(area.size.width), ((height * scale) as u32).min(area.size.height));
  w.set_size(PhysicalSize::new(full_w - (outer.width - inner.width), full_h - (outer.height - inner.height)))?;
  w.set_position(PhysicalPosition::new(area.position.x + ((area.size.width - full_w) / 2) as i32, area.position.y + ((area.size.height - full_h) / 2) as i32))
}

const SIZE: usize = 32;
// 5×7, the top row first.
const DIGITS: [[u8; 7]; 10] = [
  [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
];
const PLUS: [u8; 7] = [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0];

// A dark circle with the number in white, 99+ past that.
fn badge_pixels(count: i64) -> Vec<u8> {
  let text: Vec<&[u8; 7]> = if count > 99 { vec![&DIGITS[9], &DIGITS[9], &PLUS] } else { count.to_string().bytes().map(|b| &DIGITS[usize::from(b - b'0')]).collect() };
  let scale = if text.len() == 1 { 3 } else { 2 };
  let wide = text.len() * 6 * scale - scale;
  let (left, top) = ((SIZE - wide.min(SIZE)) / 2, (SIZE - 7 * scale) / 2);
  let lit = |x: usize, y: usize| {
    let (Some(x), Some(y)) = (x.checked_sub(left), y.checked_sub(top)) else { return false };
    let (glyph, col, row) = (x / (6 * scale), x % (6 * scale) / scale, y / scale);
    col < 5 && row < 7 && text.get(glyph).is_some_and(|g| g[row] >> (4 - col) & 1 == 1)
  };
  let mut px = Vec::with_capacity(SIZE * SIZE * 4);
  for y in 0..SIZE {
    for x in 0..SIZE {
      let (dx, dy) = (x as f64 + 0.5 - 16.0, y as f64 + 0.5 - 16.0);
      let alpha = (16.0 - (dx * dx + dy * dy).sqrt()).clamp(0.0, 1.0);
      let shade = if lit(x, y) { 0xff } else { 0x20 };
      px.extend([shade, shade, shade, (alpha * 255.0) as u8]);
    }
  }
  px
}

// Tauri's set_badge_count does nothing on Windows.
pub fn badge(w: &WebviewWindow, count: Option<i64>) {
  let _ = w.set_overlay_icon(count.map(|n| Image::new_owned(badge_pixels(n), SIZE as u32, SIZE as u32)));
}

// wisp's right-click menu holds spelling, Copy Link and editing.
// WebView2's adds what a browser has: Back, Refresh and Print in an app that has no pages, and
// submenus (More tools, Writing direction, the second named only `other`), which wisp's has none of.
const NOT_IN_THE_APP: [&str; 13] = ["back", "forward", "reload", "saveAs", "print", "share", "createQrCode", "webCapture", "webSelect", "inspectElement", "emoji", "openLinkInNewWindow", "saveLinkAs"];

unsafe fn trim_menu(items: &ICoreWebView2ContextMenuItemCollection) -> windows::core::Result<()> {
  let mut count = 0;
  items.Count(&mut count)?;
  let mut last_was_line = true; // from the bottom: no line at the end, none twice
  for i in (0..count).rev() {
    let item = items.GetValueAtIndex(i)?;
    let (mut name, mut kind) = (PWSTR::null(), Default::default());
    item.Name(&mut name)?;
    item.Kind(&mut kind)?;
    let (name, line) = (take_pwstr(name), kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR);
    #[cfg(feature = "qa")]
    note_menu_item(i, &name);
    if NOT_IN_THE_APP.contains(&name.as_str()) || kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU || (line && last_was_line) {
      items.RemoveValueAtIndex(i)?;
    } else {
      last_was_line = line;
    }
  }
  if last_was_line {
    let mut left = 0;
    items.Count(&mut left)?;
    if left > 0 {
      items.RemoveValueAtIndex(0)?; // a line at the top, with what stood above it gone
    }
  }
  Ok(())
}

// What WebView2 offered, for qa/desktop-tauri-win.mjs: no automation reaches its menu.
#[cfg(feature = "qa")]
fn note_menu_item(i: u32, name: &str) {
  use std::io::Write;
  if let Some(mut file) = std::env::var_os("WISP_QA_MENU").and_then(|f| std::fs::OpenOptions::new().create(true).append(true).open(f).ok()) {
    let _ = writeln!(file, "{i} {name}");
  }
}

pub fn plain_menu(w: &WebviewWindow) -> tauri::Result<()> {
  w.with_webview(|view| unsafe {
    let Ok(webview) = view.controller().CoreWebView2().and_then(|v| v.cast::<ICoreWebView2_11>()) else { return };
    let mut token = 0;
    let _ = webview.add_ContextMenuRequested(
      &ContextMenuRequestedEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else { return Ok(()) };
        let items = args.MenuItems()?;
        trim_menu(&items)?;
        let mut left = 0;
        items.Count(&mut left)?;
        if left == 0 {
          args.SetHandled(true)?; // nothing left to show, rather than an empty box
        }
        Ok(())
      })),
      &mut token,
    );
  })
}

#[link(name = "user32")]
extern "system" {
  fn GetKeyState(key: i32) -> i16;
}

// A key pressed in the page goes to WebView2's own process, and the menu bar never hears it: Zoom,
// Toggle Full Screen and Minimize did nothing from the keyboard. These are the keys the menu shows that
// the page doesn't keep (Ctrl+R is WebView2's own reload, the editing keys are the page's).
fn menu_key(key: u32, ctrl: bool, shift: bool) -> Option<&'static str> {
  Some(match (key, ctrl, shift) {
    (0xbb | 0x6b, true, _) => "zoom-in", // = and the keypad's +
    (0xbd | 0x6d, true, false) => "zoom-out",
    (0x30 | 0x60, true, false) => "zoom-reset",
    (0x7a, false, false) => "fullscreen", // F11
    (0x4d, true, false) => "minimize",
    _ => return None,
  })
}

pub fn menu_keys(w: &WebviewWindow) -> tauri::Result<()> {
  let app = w.app_handle().clone();
  w.with_webview(move |view| unsafe {
    let mut token = 0;
    let _ = view.controller().add_AcceleratorKeyPressed(
      &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let (mut kind, mut key) = (Default::default(), 0);
        args.KeyEventKind(&mut kind)?;
        args.VirtualKey(&mut key)?;
        let down = |k: i32| GetKeyState(k) < 0;
        if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || down(0x12) {
          return Ok(()); // Alt: the menu bar's own
        }
        if let Some(id) = menu_key(key, down(0x11), down(0x10)) {
          args.SetHandled(true)?;
          let handle = app.clone();
          let _ = app.run_on_main_thread(move || crate::menu::run(&handle, id));
        }
        Ok(())
      })),
      &mut token,
    );
  })
}
