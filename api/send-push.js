const crypto = require('crypto');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Ajustes de entrega
// ---------------------------------------------------------------------------
const MAX_ATTEMPTS = 3;            // tentativas por aparelho
const ATTEMPT_TIMEOUT_MS = 3500;   // tempo máximo de cada tentativa
const RETRY_CUTOFF_MS = 5500;      // depois disso não começa nova tentativa (Vercel Hobby: 10 s)
const TTL_SECONDS = 2 * 60 * 60;   // se o aparelho estiver sem internet, tenta por até 2 horas

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Comparação do segredo sem vazar informação pelo tempo de resposta.
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Vale tentar de novo: limite de envios (429), erro do servidor de push (5xx)
// ou falha de rede/tempo esgotado (sem statusCode).
function isRetryable(err) {
  const code = err && err.statusCode;
  return !code || code === 429 || code >= 500;
}

function retryDelay(err, attempt) {
  const retryAfter = Number(err && err.headers && err.headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 2000);
  }
  return attempt * 600;
}

async function sendWithRetry(subscription, payload, startedAt) {
  let lastError = null;
  let attempts = 0;

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;

    try {
      await webpush.sendNotification(subscription, payload, {
        // Prioridade ALTA: o Android entrega na hora, mesmo com o celular
        // parado/em segundo plano (modo Soneca/Doze).
        urgency: 'high',
        TTL: TTL_SECONDS,
        timeout: ATTEMPT_TIMEOUT_MS
      });

      return { sent: true, attempts };
    } catch (err) {
      lastError = err;

      if (
        !isRetryable(err) ||
        attempts >= MAX_ATTEMPTS ||
        Date.now() - startedAt > RETRY_CUTOFF_MS
      ) {
        break;
      }

      await sleep(retryDelay(err, attempts));
    }
  }

  return { sent: false, attempts, error: lastError };
}

function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? 'R$ ' + n.toFixed(2).replace('.', ',') : '';
}

function buildMessage(record) {
  const name = String(record.customer_name || '').trim();
  const kind = record.fulfillment_type === 'pickup' ? 'Retirada' : 'Entrega';
  const total = formatMoney(record.total);
  const paid = record.payment_method === 'site_pix' ? 'Pix' : '';

  const details = [name, kind, total, paid].filter(Boolean).join(' • ');

  return details || 'Um novo pedido chegou à cozinha.';
}

module.exports = async function handler(req, res) {
  // Aceita somente requisições POST.
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Confere o segredo enviado pelo webhook.
  const secret = process.env.PUSH_NOTIFY_SECRET;

  if (
    !secret ||
    !safeEqual(req.headers.authorization, `Bearer ${secret}`)
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

  const missingEnv = requiredEnv.filter(name => !process.env[name]);

  if (missingEnv.length > 0) {
    console.error('Variáveis de ambiente ausentes:', missingEnv.join(', '));

    return res.status(500).json({
      error: 'Server configuration incomplete'
    });
  }

  const startedAt = Date.now();

  try {
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

    // Busca as inscrições de todos os celulares cadastrados.
    const { data: subscriptions, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, subscription');

    if (error) {
      console.error('Erro ao buscar inscrições:', error.message);

      return res.status(500).json({
        error: 'Subscription lookup failed'
      });
    }

    if (!subscriptions || subscriptions.length === 0) {
      console.warn('Novo pedido, mas nenhum aparelho está inscrito.');

      return res.status(200).json({
        ok: true,
        sent: 0,
        failed: 0,
        message: 'Nenhum aparelho inscrito'
      });
    }

    const payload = JSON.stringify({
      title: 'Novo pedido recebido',
      body: buildMessage(event.record),
      url: '/',
      // Um aviso por pedido (não substitui o anterior).
      tag: 'pedido-' + event.record.id
    });

    // Envia para todos os aparelhos ao mesmo tempo. Um aparelho com problema
    // nunca atrasa nem impede o envio para os outros.
    const results = await Promise.all(
      subscriptions.map(async item => {
        let host = '';
        try { host = new URL(item.endpoint).host; } catch (_) {}

        if (!item.subscription) {
          console.error('Inscrição sem dados:', item.id);
          return { id: item.id, sent: false, statusCode: null };
        }

        const result = await sendWithRetry(
          item.subscription,
          payload,
          startedAt
        );

        if (result.sent) {
          if (result.attempts > 1) {
            console.warn(
              `Push entregue em ${result.attempts} tentativas:`,
              host
            );
          }

          return { id: item.id, sent: true, statusCode: 201 };
        }

        const err = result.error || {};
        const statusCode = err.statusCode || null;

        console.error(
          'Falha no envio push:',
          host,
          statusCode || '',
          err.message || 'Erro desconhecido',
          `(${result.attempts} tentativa(s))`
        );

        // Remove inscrições que não existem mais. O aparelho se recadastra
        // sozinho na próxima vez que o painel for aberto nele.
        if (statusCode === 404 || statusCode === 410) {
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

        return { id: item.id, sent: false, statusCode };
      })
    );

    const sent = results.filter(r => r.sent).length;
    const failed = results.length - sent;

    console.log(
      `Notificações: ${sent} enviadas; ${failed} falharam; ` +
      `${Date.now() - startedAt} ms.`
    );

    return res.status(200).json({ ok: true, sent, failed });
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
