import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMAND_GET_APP_VERSION,
  EVENT_MENU_ABOUT,
  EVENT_MENU_SETTINGS,
} from "./ipc";

// The IPC names are duplicated across the language boundary with nothing
// generating one from the other, so this asserts the Rust side still agrees.
const rustSource = readFileSync("src-tauri/src/lib.rs", "utf8");

describe("IPC names agree with the Rust backend", () => {
  it.each([
    ["EVENT_MENU_ABOUT", EVENT_MENU_ABOUT],
    ["EVENT_MENU_SETTINGS", EVENT_MENU_SETTINGS],
  ])("declares %s as a matching Rust constant", (_name, value) => {
    expect(rustSource).toContain(`"${value}"`);
  });

  it("invokes a command the backend actually registers", () => {
    expect(rustSource).toContain(`fn ${COMMAND_GET_APP_VERSION}()`);
    expect(rustSource).toContain(
      `tauri::generate_handler![${COMMAND_GET_APP_VERSION}]`,
    );
  });
});
