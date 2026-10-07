import test from 'node:test';
import assert from 'node:assert/strict';
import {hostingConfig} from '../hosting.mjs';
test('local access remains restricted to local hosts and origins',()=>{const c=hostingConfig();assert(c.allowedHosts.has('localhost:3002'));assert(!c.allowedOrigins.has('https://attacker.example'));assert.equal(c.secureCookie,'');});
test('public HTTPS allows exact website origin and explicit backend host',()=>{const c=hostingConfig({VEYLO_BIND_HOST:'0.0.0.0',VEYLO_PUBLIC_ORIGIN:'https://veylo.example',VEYLO_BACKEND_ORIGIN:'https://backend.example'});assert(c.allowedHosts.has('backend.example'));assert(!c.allowedOrigins.has('https://backend.example'));assert(!c.allowedHosts.has('attacker.example'));assert.equal(c.secureCookie,'; Secure');});
test('public setup rejects missing origin, HTTP, paths and credentials',()=>{for(const value of [undefined,'http://veylo.example','https://veylo.example/api','https://user:secret@veylo.example'])assert.throws(()=>hostingConfig({VEYLO_BIND_HOST:'0.0.0.0',VEYLO_PUBLIC_ORIGIN:value}));});
