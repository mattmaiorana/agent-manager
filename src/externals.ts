// Every external package, imported once and re-exported under the names the plugin
// code has always used. Other modules import these from here, never from the package:
// one binding per external keeps esbuild from renaming any of them.
// @codemirror/view isn't installed (Obsidian supplies it at run time); its types are
// the parts the plugin uses, in codemirror.d.ts.
import * as import_obsidian from "obsidian";
import * as import_cm_view from "@codemirror/view";
import * as import_child_process from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as string_decoder from "string_decoder";
const { StringDecoder } = string_decoder;
export { import_obsidian, import_cm_view, import_child_process, path, fs, os, StringDecoder };
