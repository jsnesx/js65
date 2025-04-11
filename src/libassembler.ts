
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Base64 } from './base64.ts'
import { Assembler } from "./assembler.ts"
import { Cpu } from "./cpu.ts"
import { Linker } from "./linker.ts"
import { Preprocessor } from "./preprocessor.ts"
import type { Options } from "./tokenizer.ts"
import { Tokenizer } from "./tokenizer.ts"
import type { ReadFileCallback, ReadFileBinaryCallback } from "./tokenstream.ts"
import { SourceContents, TokenStream } from "./tokenstream.ts"


interface AnyMap { [key: string]: any; }

async function processAction(a: Assembler, action: AnyMap, opts: Options, src: SourceContents, rf: ReadFileCallback, rfb: ReadFileBinaryCallback) {
    switch (action["action"]) {
        case "code": {
            const toks = new TokenStream(src, rf, rfb, opts);
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

export async function compile(
        modules: AnyMap[][]|string,
        romdata: Uint8Array|string,
        options: Options|string,
        readTextFileCb: (path: string, filename: string) => string,
        readBinFileCb: (path: string, filename: string) => Uint8Array|string
    ) : Promise<Uint8Array|string> {

    const mods : AnyMap[][] = (typeof modules === 'string') ? JSON.parse(modules) : modules;
    const opts : Options = (typeof options === 'string') ? JSON.parse(options) : options;
    const src: SourceContents = new SourceContents();

    async function readTextWrapper(path: string, filename: string) {
        return Promise.resolve(readTextFileCb(path, filename));
    }
    async function readBinaryWrapper(path: string, filename: string) {
        return Promise.resolve(readBinFileCb(path, filename));
    }

    // Assemble all of the modules
    const assembled = [];
    for (const module of mods) {
        let a = new Assembler(Cpu.P02);
        for (const action of module) {
            await processAction(a, action, opts, src, readTextWrapper, readBinaryWrapper);
        }
        assembled.push(a);
    }
    
    const rombytes : Uint8Array = (typeof romdata === 'string') ? new Base64().decode(romdata) : romdata;
    
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
