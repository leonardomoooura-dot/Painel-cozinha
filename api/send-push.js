
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.PUSH_NOTIFY_SECRET;

  if (
    !secret ||
    req.headers.authorization !== `Bearer ${secret}`
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const event = req.body;

  if (
    event?.type !== 'INSERT' ||
    event?.table !== 'orders' ||
    event?.schema !== 'public' ||
    !event?.record?.id
  ) {
    return res.status(400).json({ error: 'Invalid order event' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  webpush.setVapidDetails(
    'mailto:admin@casadocrepe.com.br',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const { data: subscriptions, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, subscription');

  if (error) {
    console.error('Erro ao buscar inscrições:', error.message);
    return res.status(500).json({ error: 'Subscription lookup failed' });
  }

  const payload = JSON.stringify({
    title: 'Novo pedido recebido',
    body: 'Um novo pedido chegou à cozinha.'
  });

  let sent = 0;
  let failed = 0;

  for (const item of subscriptions || []) {
    try {
      await webpush.sendNotification(item.subscription, payload);
      sent++;
    } catch (err) {
      failed++;
      console.error('Falha no envio push:', err.statusCode || err.message);

      if (err.statusCode === 404 || err.statusCode === 410) {
        await supabase
          .from('push_subscriptions')
          .delete()
          .eq('id', item.id);
      }
    }
  }

  return res.status(200).json({
    ok: true,
    sent,
    failed
  });
};
