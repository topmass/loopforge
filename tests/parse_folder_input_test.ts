import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parseFolderInput } from "../src/paths.ts";

Deno.test("parseFolderInput normalizes pasted unix paths", () => {
  assertEquals(parseFolderInput("  /tmp/repo/  "), "/tmp/repo");
  assertEquals(parseFolderInput('"/tmp/my repo/"'), "/tmp/my repo");
  assertEquals(parseFolderInput("'/tmp/repo'"), "/tmp/repo");
});

Deno.test("parseFolderInput expands ~ against HOME", () => {
  const home = Deno.env.get("HOME")!;
  assertEquals(parseFolderInput("~"), home);
  assertEquals(parseFolderInput("~/code/x"), `${home}/code/x`);
});

Deno.test("parseFolderInput decodes file:// links", () => {
  assertEquals(parseFolderInput("file:///tmp/some%20dir"), "/tmp/some dir");
  assertEquals(parseFolderInput("file:///tmp/repo/"), "/tmp/repo");
  // Windows-hosted servers get the drive shape back out of the URL form.
  assertEquals(
    parseFolderInput("file:///C:/Users/x/proj", "windows"),
    "C:\\Users\\x\\proj",
  );
});

Deno.test("parseFolderInput accepts Windows shapes only on Windows", () => {
  assertEquals(parseFolderInput("C:\\Work\\Repo\\", "windows"), "C:\\Work\\Repo");
  assertEquals(parseFolderInput("C:/Work/Repo/", "windows"), "C:\\Work\\Repo");
  assertEquals(parseFolderInput("C:\\", "windows"), "C:\\");
  assertEquals(
    parseFolderInput("\\\\server\\share\\proj", "windows"),
    "\\\\server\\share\\proj",
  );
  const err = assertThrows(
    () => parseFolderInput("C:\\Work\\Repo", "linux"),
    Error,
  );
  assertStringIncludes(err.message, "Windows path");
  assertStringIncludes(err.message, "linux");
});

Deno.test("parseFolderInput rejects relative and empty input", () => {
  assertThrows(() => parseFolderInput("notes/docs"), Error, "absolute folder path");
  assertThrows(() => parseFolderInput("   "), Error, "required");
  assertThrows(() => parseFolderInput("''"), Error, "required");
});
