
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Base64 } from './base64.ts'
import { Assembler } from "./assembler.ts"
import type { Callbacks } from "./cli.ts"
import { Cpu } from "./cpu.ts"
import { Linker } from "./linker.ts"
import { Preprocessor } from "./preprocessor.ts"
import type { Options } from "./tokenizer.ts"
import { Tokenizer } from "./tokenizer.ts"
import type { ReadFileCallback, ReadFileBinaryCallback } from "./tokenstream.ts"
import { TokenStream } from "./tokenstream.ts"


interface AnyMap { [key: string]: any; }
async function processAction(a: Assembler, action: AnyMap, opts: Options, rf: ReadFileCallback, rfb: ReadFileBinaryCallback) {
    switch (action["action"]) {
        case "code": {
            const toks = new TokenStream(rf, rfb, opts);
            const tokenizer = new Tokenizer(action["code"], action["name"], opts);
            toks.enter(tokenizer);
            const pre = new Preprocessor(toks, a);
            await a.tokens(pre);
            break;
        }
        case "label": {
            a.label(action["label"]);
            a.export(action["label"]);
            break;
        }
        case "byte": {
            a.byte(...action["bytes"]);
            break;
        }
        case "word": {
            a.word(...action["words"]);
            break;
        }
        case "org": {
            a.org(action["addr"], action["name"]);
            break;
        }
        case "reloc": {
            a.reloc(action["name"]);
            break;
        }
        case "export": {
            a.export(action["name"]);
            break;
        }
        case "segment": {
            a.segment(...action["name"]);
            break;
        }
        case "assign": {
            a.assign(action["name"], action["value"]);
            break;
        }
        case "set": {
            a.set(action["name"], action["value"]);
            break;
        }
        case "free": {
            a.free(action["size"]);
        }
    }
}

export async function compile(modules: AnyMap[][]|string, romdata: Uint8Array|string, opts: Options, callbacks: Callbacks) : Promise<Uint8Array|string> {
    debugger;
    let mods : AnyMap[][];
    if (typeof modules === 'string') {
        mods = JSON.parse(modules);
    } else {
        mods = modules;
    }
    
    const readfile = async (path: string, filename: string) => {
        const fullpath = await callbacks.fsResolve(path, filename);
        return await callbacks.fsReadString(fullpath);
    }
    const readfilebin = async (path: string, filename: string) => {
        const fullpath = await callbacks.fsResolve(path, filename);
        return await callbacks.fsReadBytes(fullpath);
    }

    // Assemble all of the modules
    const assembled = [];
    for (const module of mods) {
        let a = new Assembler(Cpu.P02);
        for (const action of module) {
            await processAction(a, action, opts, readfile, readfilebin);
        }
        assembled.push(a);
    }
    
    let rombytes : Uint8Array;
    if (typeof romdata === 'string') {
        rombytes = new Base64().decode(romdata);
    } else {
        rombytes = romdata;
    }
    // And now link them together
    const linker = new Linker();
    linker.base(rombytes, 0);
    for (const m of assembled) {
        linker.read(m.module());
    }
    const out = linker.link();
    out.apply(rombytes);
    if (typeof romdata === 'string') {
        return new Base64().encode(rombytes);
    }
    return rombytes;
}
