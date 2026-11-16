'use strict';

const DEFAULT_FILES = {
  'users.txt': [],
  'ranking.txt': [],
  'historial_clasificatoria.txt': [],
  'migration_codes.txt': []
};

class GitHubDataStore {
  constructor(env) {
    this.owner = env.GITHUB_OWNER;
    this.repo = env.GITHUB_REPO;
    this.branch = env.GITHUB_BRANCH || 'main';
    this.directory = (env.GITHUB_DATA_DIR || 'data').replace(/^\/+|\/+$/g, '');
    this.token = env.GITHUB_TOKEN;
    this.queue = Promise.resolve();
    if (!this.owner || !this.repo || !this.token) {
      throw new Error('Faltan GITHUB_OWNER, GITHUB_REPO o GITHUB_TOKEN.');
    }
  }

  pathFor(file) {
    const isPlayerFile = /^player_[a-f0-9-]{36}\.json$/i.test(String(file || ''));
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_FILES, file) && !isPlayerFile) {
      throw new Error('Archivo de datos no permitido.');
    }
    return this.directory ? `${this.directory}/${file}` : file;
  }

  async read(file) {
    const path = this.pathFor(file);
    const url = `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'digi-gacha-relay'
      }
    });
    if (response.status === 404) return { data: Object.prototype.hasOwnProperty.call(DEFAULT_FILES, file) ? JSON.parse(JSON.stringify(DEFAULT_FILES[file])) : { version: 1, updatedAt: null, snapshot: {} }, sha: null };
    if (!response.ok) throw new Error(`GitHub read failed (${response.status}).`);
    const fileData = await response.json();
    const decoded = Buffer.from(String(fileData.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
    try {
      return { data: JSON.parse(decoded), sha: fileData.sha };
    } catch (_) {
      throw new Error(`El archivo ${file} no contiene JSON válido.`);
    }
  }

  async write(file, data, sha) {
    const path = this.pathFor(file);
    const url = `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    const body = {
      message: `Actualizar ${file} desde digi-gacha-relay`,
      content: Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64'),
      branch: this.branch
    };
    if (sha) body.sha = sha;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'digi-gacha-relay'
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`GitHub write failed (${response.status}): ${detail.slice(0, 300)}`);
    }
  }

  // Serializa las operaciones dentro de esta instancia para evitar colisiones
  // de SHA cuando varios jugadores actualizan el ranking al mismo tiempo.
  transaction(work) {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async update(file, updater) {
    return this.transaction(async () => {
      const current = await this.read(file);
      const next = await updater(current.data);
      await this.write(file, next, current.sha);
      return next;
    });
  }
}

module.exports = { GitHubDataStore };
