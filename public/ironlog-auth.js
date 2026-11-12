// Cliente WebAuthn do IRONLOG (sem dependências). Usado por login.html e pelo app.
(function () {
  const b64uToBuf = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s + '='.repeat((4 - s.length % 4) % 4)); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a.buffer; };
  const bufToB64u = b => { let s = ''; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: { 'x-ironlog': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let j = {}; try { j = await r.json(); } catch (_) {}
    if (!r.ok) { const e = new Error(j.error || 'Erro ' + r.status); e.status = r.status; throw e; }
    return j;
  }
  const creationOpts = o => ({ publicKey: { ...o, challenge: b64uToBuf(o.challenge), user: { ...o.user, id: b64uToBuf(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: b64uToBuf(c.id) })) } });
  const requestOpts = o => ({ publicKey: { ...o, challenge: b64uToBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: b64uToBuf(c.id) })) } });
  const base = c => ({ id: c.id, rawId: bufToB64u(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment || undefined, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {} });
  const attJSON = c => ({ ...base(c), response: { clientDataJSON: bufToB64u(c.response.clientDataJSON), attestationObject: bufToB64u(c.response.attestationObject), transports: c.response.getTransports ? c.response.getTransports() : [] } });
  const assJSON = c => ({ ...base(c), response: { clientDataJSON: bufToB64u(c.response.clientDataJSON), authenticatorData: bufToB64u(c.response.authenticatorData), signature: bufToB64u(c.response.signature), userHandle: c.response.userHandle ? bufToB64u(c.response.userHandle) : undefined } });

  // converte erros do navegador em mensagens úteis
  function friendly(e) {
    if (e && e.name === 'NotAllowedError') return 'Cancelado ou tempo esgotado. Tente de novo.';
    if (e && e.name === 'InvalidStateError') return 'Este aparelho já tem uma passkey para esta conta.';
    if (e && e.name === 'SecurityError') return 'O navegador recusou: confira se o endereço é o oficial (HTTPS).';
    return (e && e.message) || 'Erro inesperado';
  }
  async function create(opts) { try { return await navigator.credentials.create(creationOpts(opts)); } catch (e) { throw new Error(friendly(e)); } }
  async function get(opts) { try { return await navigator.credentials.get(requestOpts(opts)); } catch (e) { throw new Error(friendly(e)); } }

  window.IronAuth = {
    api, b64uToBuf, bufToB64u,
    supported: () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create),
    async register(invite, name, label) {
      const o = await api('POST', '/api/auth/register/options', { invite, name });
      const cred = await create(o.options);
      return api('POST', '/api/auth/register/verify', { challengeId: o.challengeId, response: attJSON(cred), label });
    },
    async login() {
      const o = await api('POST', '/api/auth/login/options', {});
      const cred = await get(o.options);
      return api('POST', '/api/auth/login/verify', { challengeId: o.challengeId, response: assJSON(cred) });
    },
    async addPasskey(label) {                       // 2º aparelho, já logado
      const o = await api('POST', '/api/me/passkeys/options', {});
      const cred = await create(o.options);
      return api('POST', '/api/me/passkeys/verify', { challengeId: o.challengeId, response: attJSON(cred), label });
    },
    me: () => api('GET', '/api/me'),
    logout: () => api('POST', '/api/auth/logout', {})
  };
})();
