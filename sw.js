// Service worker do painel da cozinha (notificações de novos pedidos).

self.addEventListener('push', event => {
  let data = {
    title: 'Casa do Crepe',
    body: 'Um novo pedido chegou à cozinha.',
    tag: 'casa-do-crepe-novo-pedido',
    url: '/'
  };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch (_) {
      try { data.body = event.data.text(); } catch (__) {}
    }
  }

  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    // Um aviso por pedido; o tag não repete entre pedidos diferentes.
    tag: data.tag || 'casa-do-crepe-novo-pedido',
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [300, 150, 300, 150, 300],
    timestamp: Date.now(),
    lang: 'pt-BR',
    data: { url: data.url || '/' }
  };

  event.waitUntil((async () => {
    // 1) Mostra o aviso PRIMEIRO. O Chrome exige que todo push gere uma
    //    notificação; se falhar, mostra uma versão simples para não perder o aviso.
    try {
      await self.registration.showNotification(data.title, options);
    } catch (_) {
      await self.registration.showNotification('Casa do Crepe', {
        body: 'Novo pedido na cozinha!',
        tag: 'casa-do-crepe-fallback-' + Date.now()
      });
    }

    // 2) Se o painel estiver aberto em algum aparelho, manda atualizar na hora.
    try {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      });

      windows.forEach(client =>
        client.postMessage({ type: 'push-recebido', tag: data.tag })
      );
    } catch (_) {}
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(windowClients => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.postMessage({ type: 'push-recebido' });
          return client.focus();
        }
      }

      return self.clients.openWindow(target);
    })
  );
});

// Necessário para o Chrome oferecer "Instalar app". Não altera nada: toda
// requisição continua indo direto para a rede, como antes.
self.addEventListener('fetch', () => {});

// Atualiza o service worker nos celulares assim que houver uma versão nova.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
