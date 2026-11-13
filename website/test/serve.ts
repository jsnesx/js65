import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, sep, extname} from 'node:path';

const root = resolve('website/public');
const types: Record<string, string> = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml'};
export const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname);
    if (!path.startsWith('/js65/')) { response.writeHead(404).end(); return; }
    let file = resolve(root, path.slice('/js65/'.length));
    if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    if (path.endsWith('/')) file = resolve(file, 'index.html');
    if (path === '/js65/__test/prototype.js') file = resolve('build/website-prototype/prototype.js');
    const content = await readFile(file);
    response.writeHead(200, {'Content-Type': types[extname(file)] ?? 'application/octet-stream'});
    response.end(content);
  } catch { response.writeHead(404).end(); }
}).listen(4173, '127.0.0.1');
