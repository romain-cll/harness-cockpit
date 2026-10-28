import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { daemonFiles, listDaemonFiles, PROTOCOL_VERSION, SCROLLBACK } from '../src/index';
import { makeHome, registerCleanup } from './helpers';

registerCleanup();

describe('names and constants', () => {
  test('AC1, AC5 — the protocol is 1, the scrollback 1000 lines, and a daemon owns flat daemon-<protocol>-<build> files in the home', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(SCROLLBACK).toBe(1000);
    expect(daemonFiles('/h', 1, 'ab12cd34-44.9.1-1.2.0')).toEqual({
      socket: '/h/daemon-1-ab12cd34-44.9.1-1.2.0.sock',
      token: '/h/daemon-1-ab12cd34-44.9.1-1.2.0.token',
      pid: '/h/daemon-1-ab12cd34-44.9.1-1.2.0.pid',
      log: '/h/daemon-1-ab12cd34-44.9.1-1.2.0.log',
    });
  });

  test('AC1 — listDaemonFiles finds the daemons of a home by their files, whatever their protocol', () => {
    const home = makeHome();
    writeFileSync(join(home, 'daemon-1-aaaa1111.pid'), '1');
    writeFileSync(join(home, 'daemon-1-bbbb2222.sock'), '');
    writeFileSync(join(home, 'daemon-2-cccc3333.sock'), '');
    writeFileSync(join(home, 'state.json'), '{}');
    mkdirSync(join(home, 'sessions'));

    const found = listDaemonFiles(home)
      .map(({ protocol, build }) => `${protocol}:${build}`)
      .sort();

    expect(found).toEqual(['1:aaaa1111', '1:bbbb2222', '2:cccc3333']);
  });
});
