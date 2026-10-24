
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  // Aceita somente requisições POST.
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Confere o segredo enviado pelo webhook.
  const secret = process.env.PUSH_NOTIFY_SECRET;

  if (
    !secret ||
    req.headers.authorization !== `Bearer ${secret}`
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Confere se o evento recebido corresponde a um novo pedido.
  const event = req.body;

  if (
    event?.type !== 'INSERT' ||
    event?.table !== 'orders' ||
    event?.schema !== 'public' ||
    !event?.record?.id
  ) {
    return res.status(400).json({ error: 'Invalid order event' });
  }

  // Confere se as variáveis necessárias estão configuradas.
  const requiredEnv = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY'
  ];

  const missingEnv = requiredEnv.filter(
    name => !process.env[name]
  );

  if (missingEnv.length > 0) {
    console.error(
      'Variáveis de ambiente ausentes:',
      missingEnv.join(', ')
    );

    return res.status(500).json({
      error: 'Server configuration incomplete'
    });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false
        }
      }
    );

    webpush.setVapidDetails(
      'mailto:admin@casadocrepe.com.br',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    // Busca as inscrições de todos os celulares cadastrados.
    const { data: subscriptions, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, subscription');

    if (error) {
      console.error(
        'Erro ao buscar inscrições:',
        error.message
      );

      return res.status(500).json({
        error: 'Subscription lookup failed'
      });
    }

    if (!subscriptions || subscriptions.length === 0) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        failed: 0,
        message: 'Nenhum aparelho inscrito'
      });
    }

    const payload = JSON.stringify({
      title: 'Novo pedido recebido',
      body: 'Um novo pedido chegou à cozinha.',
      url: '/'
    });

    // Envia para os aparelhos em paralelo.
    const results = await Promise.all(
      subscriptions.map(async item => {
        try {
          if (!item.subscription) {
            throw new Error('Inscrição sem dados');
          }

          await webpush.sendNotification(
            item.subscription,
            payload,
            { TTL: 60 * 60 }
          );

          return {
            sent: true
          };
        } catch (err) {
          console.error(
            'Falha no envio push:',
            err.statusCode || '',
            err.message || 'Erro desconhecido'
          );

          // Remove inscrições expiradas ou que não existem mais.
          if (
            err.statusCode === 404 ||
            err.statusCode === 410
          ) {
            const { error: deleteError } = await supabase
              .from('push_subscriptions')
              .delete()
              .eq('id', item.id);

            if (deleteError) {
              console.error(
                'Erro ao remover inscrição expirada:',
                deleteError.message
              );
            }
          }

          return {
            sent: false,
            statusCode: err.statusCode || null
          };
        }
      })
    );

    const sent = results.filter(
      result => result.sent
    ).length;

    const failed = results.length - sent;

    console.log(
      `Notificações: ${sent} enviadas; ${failed} falharam.`
    );

    return res.status(200).json({
      ok: true,
      sent,
      failed
    });
  } catch (err) {
    console.error(
      'Erro interno no envio de notificações:',
      err.message || err
    );

    return res.status(500).json({
      error: 'Internal notification error'
    });
  }
};
