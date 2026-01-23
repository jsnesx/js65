// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { dotnet } from './_framework/dotnet.js'

// File cache for synchronous access (files must be preloaded)
const fileCache = new Map();

// Preload files that will be needed by the assembler
async function preloadFiles() {
    const filesToPreload = ['example.s'];
    for (const file of filesToPreload) {
        try {
            const response = await fetch(file);
            if (response.ok) {
                fileCache.set(file, await response.text());
            }
        } catch (e) {
            console.warn(`Failed to preload ${file}:`, e);
        }
    }
}

// Export file reading functions for C# JSImport
// In browser context, these read from the preloaded cache
export function readFileAsTextSync(path) {
    // Normalize path - remove leading ./
    const normalizedPath = path.replace(/^\.\//, '');
    if (fileCache.has(normalizedPath)) {
        return fileCache.get(normalizedPath);
    }
    console.warn(`File not found in cache: ${path}`);
    return "";
}

export function readFileAsBinarySync(path) {
    // For binary files, we'd need to preload as ArrayBuffer and convert to base64
    // For now, return empty string as this example doesn't use binary includes
    console.warn(`Binary file reading not implemented: ${path}`);
    return "";
}

// Preload files before initializing dotnet
await preloadFiles();

const { setModuleImports, getAssemblyExports, getConfig, runMain } = await dotnet
    .create();

setModuleImports('main.js', {
    // Empty for now - we export functions at module level for JSImport
});

const config = getConfig();
const exports = await getAssemblyExports(config.mainAssemblyName);

const runButton = document.getElementById('runAssembler');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');

runButton.addEventListener('click', async (e) => {
    e.preventDefault();
    runButton.disabled = true;
    statusEl.textContent = 'Running assembler...';
    outputEl.textContent = '';

    try {
        const result = await exports.BrowserExample.RunExample();
        outputEl.textContent = result;
        statusEl.textContent = 'Completed successfully!';
    } catch (error) {
        outputEl.textContent = `Error: ${error.message}\n\n${error.stack || ''}`;
        statusEl.textContent = 'Error occurred';
        console.error('Assembler error:', error);
    } finally {
        runButton.disabled = false;
    }
});

// Run the C# Main() method
await runMain(config.mainAssemblyName, [window.location.search]);
