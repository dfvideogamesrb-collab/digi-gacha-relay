'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function timingSafeTextEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class AuthApi {
  constructor(store, secret) {
    if (!secret || secret.length < 32) {
      throw new Error('AUTH_TOKEN_SECRET debe tener al menos 32 caracteres aleatorios.');
    }
    this.store = store;
    this.secret = secret;
  }

  async hashPassword(password, saltHex) {
    const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
    const derived = await scrypt(password, salt, 64);
    return { salt: salt.toString('hex'), passwordHash: derived.toString('hex') };
  }

  issueToken(user) {
    const payload = base64url(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }));
    const signature = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const expected = crypto.createHmac('sha256', this.secret).update(parts[0]).digest('base64url');
    if (!timingSafeTextEqual(parts[1], expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (!payload.sub || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch (_) {
      return null;
    }
  }

  async findUser(username) {
    const result = await this.store.read('users.txt');
    const normalized = String(username || '').toLowerCase();
    return (Array.isArray(result.data) ? result.data : []).find(u => String(u.usuario).toLowerCase() === normalized) || null;
  }

  async createUser(input) {
    const usuario = String(input.usuario || '').trim();
    const nombrePersonaje = String(input.nombrePersonaje || usuario).trim();
    const password = String(input.password || '');
    if (!USERNAME_RE.test(usuario)) {
      const error = new Error('El usuario debe tener entre 3 y 24 caracteres: letras, números, punto, guion o guion bajo.');
      error.status = 400; throw error;
    }
    if (nombrePersonaje.length < 1 || nombrePersonaje.length > 30) {
      const error = new Error('El nombre del Tamer debe tener entre 1 y 30 caracteres.');
      error.status = 400; throw error;
    }
    if (password.length < 6 || password.length > 128) {
      const error = new Error('La contraseña debe tener al menos 6 caracteres.');
      error.status = 400; throw error;
    }

    return this.store.transaction(async () => {
      const usersFile = await this.store.read('users.txt');
      const users = Array.isArray(usersFile.data) ? usersFile.data : [];
      const exists = users.some(u => String(u.usuario).toLowerCase() === usuario.toLowerCase());
      if (exists) {
        const error = new Error('Ese usuario ya está vinculado a una cuenta online.');
        error.status = 409; throw error;
      }
      const credentials = await this.hashPassword(password);
      const user = {
        id: crypto.randomUUID(),
        usuario,
        nombrePersonaje,
        salt: credentials.salt,
        passwordHash: credentials.passwordHash,
        createdAt: new Date().toISOString()
      };
      users.push(user);
      await this.store.write('users.txt', users, usersFile.sha);

      const rankingFile = await this.store.read('ranking.txt');
      const ranking = Array.isArray(rankingFile.data) ? rankingFile.data : [];
      if (!ranking.some(row => row.userId === user.id)) {
        ranking.push({
          userId: user.id,
          usuario: user.usuario,
          nombrePersonaje: user.nombrePersonaje,
          puntos: 0,
          rango: 'Madera',
          division: 5,
          victorias: 0,
          derrotas: 0,
          empates: 0
        });
        await this.store.write('ranking.txt', ranking, rankingFile.sha);
      }
      return user;
    });
  }

  async createMigrationCode(username) {
    const usuario = String(username || '').trim();
    if (!USERNAME_RE.test(usuario)) {
      const error = new Error('Usuario inválido para migración.');
      error.status = 400; throw error;
    }
    return this.store.transaction(async () => {
      const file = await this.store.read('migration_codes.txt');
      const codes = Array.isArray(file.data) ? file.data : [];
      const code = crypto.randomBytes(18).toString('base64url').toUpperCase();
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');
      codes.push({
        usuario: usuario.toLowerCase(),
        codeHash,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        usedAt: null
      });
      await this.store.write('migration_codes.txt', codes, file.sha);
      return code;
    });
  }

  async linkLegacyAccount(input) {
    const usuario = String(input.usuario || '').trim();
    const nombrePersonaje = String(input.nombrePersonaje || usuario).trim();
    const password = String(input.password || '');
    const migrationCode = String(input.migrationCode || '').trim().toUpperCase();
    if (!USERNAME_RE.test(usuario) || !migrationCode) {
      const error = new Error('Usuario y código de migración son obligatorios.');
      error.status = 400; throw error;
    }
    if (password.length < 6 || password.length > 128) {
      const error = new Error('La contraseña debe tener al menos 6 caracteres.');
      error.status = 400; throw error;
    }
    if (nombrePersonaje.length < 1 || nombrePersonaje.length > 30) {
      const error = new Error('El nombre del Tamer debe tener entre 1 y 30 caracteres.');
      error.status = 400; throw error;
    }

    const user = await this.store.transaction(async () => {
      const codesFile = await this.store.read('migration_codes.txt');
      const codes = Array.isArray(codesFile.data) ? codesFile.data : [];
      const codeHash = crypto.createHash('sha256').update(migrationCode).digest('hex');
      const codeIndex = codes.findIndex(c => c.usuario === usuario.toLowerCase() &&
        !c.usedAt && new Date(c.expiresAt).getTime() > Date.now() &&
        timingSafeTextEqual(c.codeHash, codeHash));
      if (codeIndex < 0) {
        const error = new Error('Código de migración inválido, vencido o ya utilizado.');
        error.status = 401; throw error;
      }

      const usersFile = await this.store.read('users.txt');
      const users = Array.isArray(usersFile.data) ? usersFile.data : [];
      if (users.some(u => String(u.usuario).toLowerCase() === usuario.toLowerCase())) {
        const error = new Error('Ese usuario ya tiene una cuenta online.');
        error.status = 409; throw error;
      }
      const credentials = await this.hashPassword(password);
      const created = {
        id: crypto.randomUUID(),
        usuario,
        nombrePersonaje,
        salt: credentials.salt,
        passwordHash: credentials.passwordHash,
        createdAt: new Date().toISOString(),
        migrated: true
      };
      users.push(created);
      await this.store.write('users.txt', users, usersFile.sha);

      const rankingFile = await this.store.read('ranking.txt');
      const ranking = Array.isArray(rankingFile.data) ? rankingFile.data : [];
      ranking.push({ userId: created.id, usuario, nombrePersonaje, puntos: 0, rango: 'Madera', division: 5, victorias: 0, derrotas: 0, empates: 0 });
      await this.store.write('ranking.txt', ranking, rankingFile.sha);

      codes[codeIndex].usedAt = new Date().toISOString();
      await this.store.write('migration_codes.txt', codes, codesFile.sha);
      return created;
    });
    return { token: this.issueToken(user), usuario: user.usuario, nombrePersonaje: user.nombrePersonaje };
  }


  /**
   * Migra una cuenta heredada que solo existía en el almacenamiento local
   * del dispositivo original. El cliente solo llama a este método después
   * de comprobar usuario y contraseña contra su copia local.
   * Si la cuenta ya existe online, exige que la contraseña coincida.
   */
  async migrateLocalAccount(input) {
    const usuario = String(input.usuario || '').trim();
    const nombrePersonaje = String(input.nombrePersonaje || usuario).trim();
    const password = String(input.password || '');

    // Se permite un formato más amplio que el registro nuevo para no perder
    // nombres de usuario creados con versiones antiguas de la aplicación.
    if (!usuario || usuario.length > 40 || /[\u0000-\u001f]/.test(usuario)) {
      const error = new Error('El usuario local no tiene un formato válido para migración.');
      error.status = 400; throw error;
    }
    if (!nombrePersonaje || nombrePersonaje.length > 30) {
      const error = new Error('El nombre del Tamer no es válido.');
      error.status = 400; throw error;
    }
    if (!password || password.length > 128) {
      const error = new Error('La contraseña local no es válida.');
      error.status = 400; throw error;
    }

    const user = await this.store.transaction(async () => {
      const usersFile = await this.store.read('users.txt');
      const users = Array.isArray(usersFile.data) ? usersFile.data : [];
      let account = users.find(u => String(u.usuario).toLowerCase() === usuario.toLowerCase());

      if (account) {
        const calculated = await this.hashPassword(password, account.salt);
        if (!timingSafeTextEqual(calculated.passwordHash, account.passwordHash)) {
          const error = new Error('Ese usuario ya tiene una cuenta online con otra contraseña.');
          error.status = 409; throw error;
        }
      } else {
        const credentials = await this.hashPassword(password);
        account = {
          id: crypto.randomUUID(),
          usuario,
          nombrePersonaje,
          salt: credentials.salt,
          passwordHash: credentials.passwordHash,
          createdAt: new Date().toISOString(),
          migrated: true
        };
        users.push(account);
        await this.store.write('users.txt', users, usersFile.sha);
      }

      // Asegura que toda cuenta migrada tenga su entrada inicial de ranking.
      const rankingFile = await this.store.read('ranking.txt');
      const ranking = Array.isArray(rankingFile.data) ? rankingFile.data : [];
      if (!ranking.some(row => row.userId === account.id)) {
        ranking.push({
          userId: account.id,
          usuario: account.usuario,
          nombrePersonaje: account.nombrePersonaje,
          puntos: 0,
          rango: 'Madera',
          division: 5,
          victorias: 0,
          derrotas: 0,
          empates: 0
        });
        await this.store.write('ranking.txt', ranking, rankingFile.sha);
      }
      return account;
    });

    return {
      token: this.issueToken(user),
      usuario: user.usuario,
      nombrePersonaje: user.nombrePersonaje
    };
  }

  async authenticate(input, allowCreate) {
    const usuario = String(input.usuario || '').trim();
    const password = String(input.password || '');
    if (!usuario || !password) {
      const error = new Error('Usuario y contraseña son obligatorios.');
      error.status = 400; throw error;
    }
    let user = await this.findUser(usuario);
    if (!user && allowCreate) {
      user = await this.createUser({ usuario, nombrePersonaje: input.nombrePersonaje || usuario, password });
    } else if (!user) {
      const error = new Error('No existe una cuenta online vinculada con ese usuario.');
      error.status = 401; throw error;
    } else {
      const calculated = await this.hashPassword(password, user.salt);
      if (!timingSafeTextEqual(calculated.passwordHash, user.passwordHash)) {
        const error = new Error('Usuario o contraseña incorrectos.');
        error.status = 401; throw error;
      }
    }
    return {
      token: this.issueToken(user),
      usuario: user.usuario,
      nombrePersonaje: user.nombrePersonaje
    };
  }

  async getAuthenticatedUser(token) {
    const payload = this.verifyToken(token);
    if (!payload) return null;
    const result = await this.store.read('users.txt');
    const users = Array.isArray(result.data) ? result.data : [];
    return users.find(u => u.id === payload.sub) || null;
  }

  async getRanking() {
    const result = await this.store.read('ranking.txt');
    return (Array.isArray(result.data) ? result.data : []).slice().sort((a, b) => (b.puntos || 0) - (a.puntos || 0));
  }
}

module.exports = { AuthApi };
