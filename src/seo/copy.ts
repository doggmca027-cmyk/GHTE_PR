// The words of the public pages. PURE (read by the app, by the Vercel Edge middleware for bots and by the sitemap script).
//
// WHAT THE TEXTS MAY SAY is fixed by what the platform really does, not by what a search engine likes:
//   * you pay with TON into a prepaid USD balance; an order that cannot be delivered is refunded by itself; volume prices; the minimum order is $0.10;
//   * Refill (recovery) and drip-feed (gradual delivery) exist ONLY on the services that state them in their name: every list line shows both;
//   * "Real" / "HQ" are labels in the names of some services, not a property of every service;
//   * no immunity from the algorithms of the social networks is promised (the owner's own wording), no account safety, no position in a search;
//   * there is no public API for customers: no page may mention one.
// A page that targets a phrase ("real followers", "premium", "slow auto views") says in its text what the label means and that the list shows what each
// service is. Placeholders: {platform}, {what} (the noun, or the flavour with its noun).

import type { LangCode } from '../i18n/languages.ts'
import { LANDING_LANGS, type Flavor, type Landing, type ServiceKind, type Topic } from './pages.ts'

export interface Copy {
  /** The nouns, in the form "buy ___" wants (plural). */
  kinds: Record<ServiceKind, string>
  /** What Telegram calls its followers. */
  telegramFollowers: string
  /** The flavours that have a page: the noun phrase of each. */
  flavored: Record<'premium-followers' | 'slow-auto-views' | 'real-followers', string>
  /** How a platform is written in this language, where it differs from the brand's own spelling (the search phrase of that language). */
  platformNames?: Partial<Record<string, string>>
  h1: string
  /** The <title>: {h1} is the page's own heading. */
  title: string
  description: string
  intro: string
  facts: readonly [string, string, string, string]
  factsHeading: string
  faqHeading: string
  faq: readonly [{ q: string; a: string }, { q: string; a: string }, { q: string; a: string }]
  ctaTelegram: string
  ctaWeb: string
  topics: Record<Topic, { h1: string; intro: string; description: string }>
}

export const COPY: Partial<Record<LangCode, Copy>> = {
  en: {
    kinds: { followers: 'followers', views: 'views', likes: 'likes', comments: 'comments', reactions: 'reactions', plays: 'plays' },
    telegramFollowers: 'subscribers',
    flavored: { 'premium-followers': 'premium followers', 'slow-auto-views': 'slow auto views', 'real-followers': 'real followers' },
    h1: 'Buy {platform} {what} with TON',
    title: '{h1} | GRAM Hub',
    description: '{platform} {what}: pay with TON from a prepaid USD balance, automatic refund if an order cannot be delivered, volume prices, orders from $0.10. Works in Telegram and in the browser.',
    intro: 'GRAM Hub sells {platform} {what} from a prepaid USD balance that you top up with TON. Pick a service, paste your link, set the quantity and see the final price before you pay. Labels such as Real, HQ, Premium, Refill and Drip-feed come from the name of each service: the list shows what every service is, nothing is promised that it does not say.',
    factsHeading: 'What you get',
    facts: [
      'Pay with TON: top up a prepaid USD balance in the app, no bank card needed.',
      'Automatic refund when an order cannot be delivered.',
      'Refill (recovery) and drip-feed (gradual delivery) on the services that state them in their name; the list shows both for every service.',
      'Volume prices for large orders; the minimum order is $0.10.',
    ],
    faqHeading: 'Questions',
    faq: [
      { q: 'Can I pay with TON?', a: 'Yes. You top up a prepaid USD balance with TON inside the app and pay for orders from it.' },
      { q: 'What do Refill and drip-feed mean?', a: 'Refill means the service restores part of the engagement if the social network removes it, for the term written in the service name. Drip-feed spreads the delivery over time. Only the services that state them have them, and we do not promise immunity from the algorithms of social networks.' },
      { q: 'How small can an order be?', a: 'The minimum order amount is $0.10, and every service shows its own minimum quantity.' },
    ],
    ctaTelegram: 'Open in Telegram',
    ctaWeb: 'Open the web app',
    topics: {
      'crypto-smm-panel': {
        h1: 'SMM panel with crypto payments (TON)',
        intro: 'GRAM Hub is an SMM panel where you pay in crypto: top up a prepaid USD balance with TON, then order followers, views, likes and members for Telegram, Instagram, YouTube, TikTok and 60+ platforms. An order that cannot be delivered is refunded automatically.',
        description: 'SMM panel paid with TON: prepaid USD balance, automatic refunds, 60+ platforms, works in Telegram and in the browser.',
      },
      'smm-panel-for-agencies': {
        h1: 'SMM panel for agencies: volume prices, pay with TON',
        intro: 'Agencies and resellers get volume prices on large orders, one prepaid balance that is topped up with TON and one catalogue for 60+ platforms. Prices are shown per 1,000 and the final price is checked before every order.',
        description: 'SMM panel for agencies: volume prices, one balance for 60+ platforms, pay with TON.',
      },
    },
  },
  ru: {
    kinds: { followers: 'подписчиков', views: 'просмотры', likes: 'лайки', comments: 'комментарии', reactions: 'реакции', plays: 'прослушивания' },
    telegramFollowers: 'подписчиков',
    flavored: { 'premium-followers': 'премиум подписчиков', 'slow-auto-views': 'медленные автопросмотры', 'real-followers': 'подписчиков с меткой Real' },
    h1: 'Купить {what} {platform} за TON',
    title: '{h1} | GRAM Hub',
    description: 'Купить {what} {platform}: оплата в TON с предоплаченного баланса в USD, автоматический возврат, если заказ нельзя выполнить, оптовые цены, заказы от $0,10. Работает в Telegram и в браузере.',
    intro: 'GRAM Hub продаёт {what} {platform} с предоплаченного баланса в USD, который пополняется в TON. Выберите услугу, вставьте ссылку, укажите количество и увидите итоговую цену до оплаты. Метки Real, HQ, Premium, Refill и Drip-feed берутся из названия каждой услуги: в списке видно, что это за услуга, и ничего не обещано сверх того, что в ней написано.',
    factsHeading: 'Что вы получаете',
    facts: [
      'Оплата в TON: баланс в USD пополняется в приложении, банковская карта не нужна.',
      'Автоматический возврат, если заказ нельзя выполнить.',
      'Refill (восстановление) и drip-feed (плавная подача) есть у услуг, где они указаны в названии; список показывает оба параметра для каждой услуги.',
      'Оптовые цены на большие заказы; минимальная сумма заказа — $0,10.',
    ],
    faqHeading: 'Вопросы',
    faq: [
      { q: 'Можно ли платить в TON?', a: 'Да. Вы пополняете предоплаченный баланс в USD в TON прямо в приложении и оплачиваете заказы с него.' },
      { q: 'Что такое Refill и drip-feed?', a: 'Refill — услуга восстанавливает часть накрутки, если соцсеть её спишет, в срок, указанный в названии. Drip-feed — плавная подача по времени. Они есть только у услуг, где указаны, и мы не обещаем иммунитет от алгоритмов соцсетей.' },
      { q: 'Какой заказ минимальный?', a: 'Минимальная сумма заказа — $0,10, а у каждой услуги указано своё минимальное количество.' },
    ],
    ctaTelegram: 'Открыть в Telegram',
    ctaWeb: 'Открыть веб-версию',
    topics: {
      'crypto-smm-panel': {
        h1: 'SMM-панель с оплатой в крипте (TON)',
        intro: 'GRAM Hub — SMM-панель, где платят криптовалютой: пополните предоплаченный баланс в USD в TON и заказывайте подписчиков, просмотры, лайки и участников для Telegram, Instagram, YouTube, TikTok и более 60 платформ. Заказ, который нельзя выполнить, возвращается автоматически.',
        description: 'SMM-панель с оплатой в TON: предоплаченный баланс в USD, автоматический возврат, 60+ платформ, работает в Telegram и в браузере.',
      },
      'smm-panel-for-agencies': {
        h1: 'SMM-панель для агентств: оптовые цены, оплата в TON',
        intro: 'Агентства и реселлеры получают оптовые цены на большие заказы, один предоплаченный баланс, который пополняется в TON, и единый каталог для 60+ платформ. Цены указаны за 1000, а итоговая цена проверяется перед каждым заказом.',
        description: 'SMM-панель для агентств: оптовые цены, один баланс для 60+ платформ, оплата в TON.',
      },
    },
  },
  uk: {
    kinds: { followers: 'підписників', views: 'перегляди', likes: 'лайки', comments: 'коментарі', reactions: 'реакції', plays: 'прослуховування' },
    telegramFollowers: 'підписників',
    flavored: { 'premium-followers': 'преміум підписників', 'slow-auto-views': 'повільні автоперегляди', 'real-followers': 'підписників із позначкою Real' },
    h1: 'Купити {what} {platform} за TON',
    title: '{h1} | GRAM Hub',
    description: 'Купити {what} {platform}: оплата в TON з передплаченого балансу в USD, автоматичне повернення, якщо замовлення неможливо виконати, оптові ціни, замовлення від $0,10. Працює в Telegram і в браузері.',
    intro: 'GRAM Hub продає {what} {platform} з передплаченого балансу в USD, який поповнюється в TON. Оберіть послугу, вставте посилання, вкажіть кількість і побачите підсумкову ціну до оплати. Позначки Real, HQ, Premium, Refill і Drip-feed беруться з назви кожної послуги: у списку видно, що це за послуга, і нічого не обіцяно понад те, що в ній написано.',
    factsHeading: 'Що ви отримуєте',
    facts: [
      'Оплата в TON: баланс у USD поповнюється в застосунку, банківська картка не потрібна.',
      'Автоматичне повернення коштів, якщо замовлення неможливо виконати.',
      'Refill (відновлення) і drip-feed (плавна подача) є в послуг, де вони вказані в назві; список показує обидва параметри для кожної послуги.',
      'Оптові ціни на великі замовлення; мінімальна сума замовлення — $0,10.',
    ],
    faqHeading: 'Запитання',
    faq: [
      { q: 'Чи можна платити в TON?', a: 'Так. Ви поповнюєте передплачений баланс у USD в TON просто в застосунку й оплачуєте замовлення з нього.' },
      { q: 'Що таке Refill і drip-feed?', a: 'Refill — послуга відновлює частину накрутки, якщо соцмережа її спише, на термін, указаний у назві. Drip-feed — плавна подача в часі. Вони є лише в послуг, де вказані, і ми не обіцяємо імунітет від алгоритмів соцмереж.' },
      { q: 'Яке замовлення мінімальне?', a: 'Мінімальна сума замовлення — $0,10, а в кожної послуги вказана своя мінімальна кількість.' },
    ],
    ctaTelegram: 'Відкрити в Telegram',
    ctaWeb: 'Відкрити веб-версію',
    topics: {
      'crypto-smm-panel': {
        h1: 'SMM-панель з оплатою в криптовалюті (TON)',
        intro: 'GRAM Hub — SMM-панель, де платять криптовалютою: поповніть передплачений баланс у USD в TON і замовляйте підписників, перегляди, лайки та учасників для Telegram, Instagram, YouTube, TikTok і понад 60 платформ. Замовлення, яке неможливо виконати, повертається автоматично.',
        description: 'SMM-панель з оплатою в TON: передплачений баланс у USD, автоматичне повернення, 60+ платформ, працює в Telegram і в браузері.',
      },
      'smm-panel-for-agencies': {
        h1: 'SMM-панель для агентств: оптові ціни, оплата в TON',
        intro: 'Агентства й реселери отримують оптові ціни на великі замовлення, один передплачений баланс, який поповнюється в TON, і єдиний каталог для 60+ платформ. Ціни вказані за 1000, а підсумкова ціна перевіряється перед кожним замовленням.',
        description: 'SMM-панель для агентств: оптові ціни, один баланс для 60+ платформ, оплата в TON.',
      },
    },
  },
  es: {
    kinds: { followers: 'seguidores', views: 'vistas', likes: 'likes', comments: 'comentarios', reactions: 'reacciones', plays: 'reproducciones' },
    telegramFollowers: 'suscriptores',
    flavored: { 'premium-followers': 'seguidores premium', 'slow-auto-views': 'vistas automáticas lentas', 'real-followers': 'seguidores reales' },
    h1: 'Comprar {what} de {platform} con TON',
    title: '{h1} | GRAM Hub',
    description: 'Comprar {what} de {platform}: pago con TON desde un saldo prepago en USD, reembolso automático si un pedido no se puede entregar, precios por volumen, pedidos desde $0,10. Funciona en Telegram y en el navegador.',
    intro: 'GRAM Hub vende {what} de {platform} desde un saldo prepago en USD que recargas con TON. Elige un servicio, pega tu enlace, indica la cantidad y ve el precio final antes de pagar. Las etiquetas Real, HQ, Premium, Refill y Drip-feed salen del nombre de cada servicio: la lista muestra qué es cada uno y no se promete nada que no diga.',
    factsHeading: 'Qué obtienes',
    facts: [
      'Pago con TON: recargas un saldo prepago en USD en la app, sin tarjeta bancaria.',
      'Reembolso automático cuando un pedido no se puede entregar.',
      'Refill (reposición) y drip-feed (entrega gradual) en los servicios que los indican en su nombre; la lista muestra ambos en cada servicio.',
      'Precios por volumen en pedidos grandes; el pedido mínimo es de $0,10.',
    ],
    faqHeading: 'Preguntas',
    faq: [
      { q: '¿Puedo pagar con TON?', a: 'Sí. Recargas un saldo prepago en USD con TON dentro de la app y pagas los pedidos con él.' },
      { q: '¿Qué significan Refill y drip-feed?', a: 'Refill significa que el servicio repone parte de la interacción si la red social la elimina, durante el plazo que indica el nombre. Drip-feed reparte la entrega en el tiempo. Solo lo tienen los servicios que lo indican, y no prometemos inmunidad frente a los algoritmos de las redes sociales.' },
      { q: '¿Cuál es el pedido mínimo?', a: 'El importe mínimo del pedido es de $0,10 y cada servicio muestra su propia cantidad mínima.' },
    ],
    ctaTelegram: 'Abrir en Telegram',
    ctaWeb: 'Abrir la versión web',
    topics: {
      'crypto-smm-panel': {
        h1: 'Panel SMM con pagos en cripto (TON)',
        intro: 'GRAM Hub es un panel SMM donde pagas con criptomonedas: recarga un saldo prepago en USD con TON y pide seguidores, vistas, likes y miembros para Telegram, Instagram, YouTube, TikTok y más de 60 plataformas. Un pedido que no se puede entregar se reembolsa automáticamente.',
        description: 'Panel SMM con pago en TON: saldo prepago en USD, reembolsos automáticos, más de 60 plataformas, funciona en Telegram y en el navegador.',
      },
      'smm-panel-for-agencies': {
        h1: 'Panel SMM para agencias: precios por volumen, pago con TON',
        intro: 'Las agencias y los revendedores obtienen precios por volumen en pedidos grandes, un único saldo prepago que se recarga con TON y un catálogo para más de 60 plataformas. Los precios se muestran por 1000 y el precio final se comprueba antes de cada pedido.',
        description: 'Panel SMM para agencias: precios por volumen, un saldo para más de 60 plataformas, pago con TON.',
      },
    },
  },
  ar: {
    kinds: { followers: 'متابعين', views: 'مشاهدات', likes: 'إعجابات', comments: 'تعليقات', reactions: 'تفاعلات', plays: 'مرات استماع' },
    telegramFollowers: 'مشتركين',
    flavored: { 'premium-followers': 'متابعين بريميوم', 'slow-auto-views': 'مشاهدات تلقائية بطيئة', 'real-followers': 'متابعين حقيقيين' },
    platformNames: { telegram: 'تيليجرام', instagram: 'انستقرام', tiktok: 'تيك توك', youtube: 'يوتيوب', twitter: 'إكس (تويتر)', facebook: 'فيسبوك', spotify: 'سبوتيفاي', twitch: 'تويتش', vk: 'في كي' },
    h1: 'شراء {what} {platform} بعملة TON',
    title: '{h1} | GRAM Hub',
    description: 'شراء {what} {platform}: الدفع بعملة TON من رصيد مسبق الدفع بالدولار، واسترداد تلقائي إذا تعذّر تنفيذ الطلب، وأسعار للكميات الكبيرة، وطلبات من 0.10$. يعمل داخل تيليجرام وفي المتصفح.',
    intro: 'يبيع GRAM Hub {what} {platform} من رصيد مسبق الدفع بالدولار تشحنه بعملة TON. اختر الخدمة وألصق الرابط وحدّد الكمية وشاهد السعر النهائي قبل الدفع. علامات مثل Real وHQ وPremium وRefill وDrip-feed مأخوذة من اسم كل خدمة: القائمة توضح ما هي كل خدمة، ولا نَعِد بأكثر مما كُتب فيها.',
    factsHeading: 'ما الذي تحصل عليه',
    facts: [
      'الدفع بعملة TON: اشحن رصيدًا مسبق الدفع بالدولار داخل التطبيق دون بطاقة بنكية.',
      'استرداد تلقائي عندما يتعذّر تنفيذ الطلب.',
      'Refill (التعويض) وdrip-feed (التسليم التدريجي) في الخدمات التي تذكرهما في اسمها؛ وتعرض القائمة كليهما لكل خدمة.',
      'أسعار خاصة للكميات الكبيرة؛ والحد الأدنى للطلب 0.10$.',
    ],
    faqHeading: 'أسئلة',
    faq: [
      { q: 'هل يمكنني الدفع بعملة TON؟', a: 'نعم. تشحن رصيدًا مسبق الدفع بالدولار بعملة TON داخل التطبيق وتدفع منه ثمن الطلبات.' },
      { q: 'ما معنى Refill وdrip-feed؟', a: 'يعني Refill أن الخدمة تعوّض جزءًا من التفاعل إذا حذفته الشبكة الاجتماعية خلال المدة المكتوبة في اسم الخدمة. ويعني Drip-feed توزيع التسليم على مدى زمني. لا توجد هذه الميزات إلا في الخدمات التي تذكرها، ولا نَعِد بحصانة ضد خوارزميات الشبكات الاجتماعية.' },
      { q: 'ما هو أصغر طلب؟', a: 'الحد الأدنى لمبلغ الطلب 0.10$، وتعرض كل خدمة الحد الأدنى للكمية الخاص بها.' },
    ],
    ctaTelegram: 'افتح في تيليجرام',
    ctaWeb: 'افتح نسخة الويب',
    topics: {
      'crypto-smm-panel': {
        h1: 'لوحة SMM بالدفع بالعملات المشفرة (TON)',
        intro: 'GRAM Hub لوحة SMM تدفع فيها بالعملات المشفرة: اشحن رصيدًا مسبق الدفع بالدولار بعملة TON ثم اطلب متابعين ومشاهدات وإعجابات وأعضاء لتيليجرام وانستقرام ويوتيوب وتيك توك وأكثر من 60 منصة. ويُسترد تلقائيًا أي طلب يتعذّر تنفيذه.',
        description: 'لوحة SMM بالدفع بعملة TON: رصيد مسبق الدفع بالدولار، واسترداد تلقائي، وأكثر من 60 منصة، وتعمل داخل تيليجرام وفي المتصفح.',
      },
      'smm-panel-for-agencies': {
        h1: 'لوحة SMM للوكالات: أسعار للكميات الكبيرة والدفع بعملة TON',
        intro: 'تحصل الوكالات والموزّعون على أسعار للكميات الكبيرة، ورصيد واحد مسبق الدفع يُشحن بعملة TON، وكتالوج واحد لأكثر من 60 منصة. الأسعار معروضة لكل 1000 ويُتحقق من السعر النهائي قبل كل طلب.',
        description: 'لوحة SMM للوكالات: أسعار للكميات الكبيرة، رصيد واحد لأكثر من 60 منصة، والدفع بعملة TON.',
      },
    },
  },
}

/** The title and the description of the home page (/<lang>/), in every language of the app. English is the one of index.html. */
export const HOME_META: Record<LangCode, { title: string; description: string }> = {
  en: { title: 'GRAM Hub — social media promotion paid with TON', description: 'GRAM Hub: followers, views, likes and members for Telegram, Instagram, YouTube, TikTok and 60+ platforms. Prepaid USD balance topped up with TON, automatic refunds, bulk prices. Works in Telegram and in the browser.' },
  ru: { title: 'GRAM Hub — продвижение в соцсетях за TON', description: 'Подписчики, просмотры, лайки и участники для Telegram, Instagram, YouTube, TikTok и 60+ платформ. Предоплаченный баланс в USD, пополнение в TON, автоматический возврат, оптовые цены. Работает в Telegram и в браузере.' },
  uk: { title: 'GRAM Hub — просування в соцмережах за TON', description: 'Підписники, перегляди, лайки та учасники для Telegram, Instagram, YouTube, TikTok і 60+ платформ. Передплачений баланс у USD, поповнення в TON, автоматичне повернення коштів, оптові ціни. Працює в Telegram і в браузері.' },
  es: { title: 'GRAM Hub — promoción en redes sociales pagada con TON', description: 'Seguidores, vistas, likes y miembros para Telegram, Instagram, YouTube, TikTok y más de 60 plataformas. Saldo prepago en USD recargado con TON, reembolsos automáticos y precios por volumen. Funciona en Telegram y en el navegador.' },
  pt: { title: 'GRAM Hub — divulgação em redes sociais paga com TON', description: 'Seguidores, visualizações, curtidas e membros para Telegram, Instagram, YouTube, TikTok e mais de 60 plataformas. Saldo pré-pago em USD recarregado com TON, reembolso automático e preços por volume. Funciona no Telegram e no navegador.' },
  id: { title: 'GRAM Hub — promosi media sosial dibayar dengan TON', description: 'Pengikut, tayangan, suka, dan anggota untuk Telegram, Instagram, YouTube, TikTok, dan 60+ platform. Saldo USD prabayar yang diisi dengan TON, pengembalian dana otomatis, harga grosir. Berfungsi di Telegram dan di browser.' },
  tr: { title: 'GRAM Hub — TON ile ödenen sosyal medya tanıtımı', description: "Telegram, Instagram, YouTube, TikTok ve 60'tan fazla platform için takipçi, izlenme, beğeni ve üye. TON ile yüklenen ön ödemeli USD bakiye, otomatik iade, toplu fiyatlar. Telegram'da ve tarayıcıda çalışır." },
  ar: { title: 'GRAM Hub — الترويج على وسائل التواصل بالدفع عبر TON', description: 'متابعون ومشاهدات وإعجابات وأعضاء لتيليجرام وإنستغرام ويوتيوب وتيك توك وأكثر من 60 منصة. رصيد مسبق الدفع بالدولار يُشحن عبر TON، واسترداد تلقائي، وأسعار الجملة. يعمل داخل تيليجرام وفي المتصفح.' },
  hi: { title: 'GRAM Hub — TON से भुगतान वाला सोशल मीडिया प्रमोशन', description: 'Telegram, Instagram, YouTube, TikTok और 60+ प्लेटफ़ॉर्म के लिए फ़ॉलोअर्स, व्यूज़, लाइक्स और मेंबर्स। TON से रिचार्ज होने वाला प्रीपेड USD बैलेंस, अपने-आप रिफ़ंड और थोक कीमतें। Telegram और ब्राउज़र दोनों में काम करता है।' },
  fr: { title: 'GRAM Hub — promotion sur les réseaux sociaux payée en TON', description: 'Abonnés, vues, likes et membres pour Telegram, Instagram, YouTube, TikTok et plus de 60 plateformes. Solde prépayé en USD rechargé en TON, remboursements automatiques, prix dégressifs. Fonctionne dans Telegram et dans le navigateur.' },
  de: { title: 'GRAM Hub — Social-Media-Promotion, bezahlt mit TON', description: 'Follower, Aufrufe, Likes und Mitglieder für Telegram, Instagram, YouTube, TikTok und mehr als 60 Plattformen. Vorausbezahltes USD-Guthaben, aufgeladen mit TON, automatische Rückerstattung, Mengenpreise. Funktioniert in Telegram und im Browser.' },
  it: { title: 'GRAM Hub — promozione sui social pagata con TON', description: 'Follower, visualizzazioni, like e membri per Telegram, Instagram, YouTube, TikTok e oltre 60 piattaforme. Saldo prepagato in USD ricaricato con TON, rimborsi automatici, prezzi a volume. Funziona su Telegram e nel browser.' },
  vi: { title: 'GRAM Hub — quảng bá mạng xã hội thanh toán bằng TON', description: 'Người theo dõi, lượt xem, lượt thích và thành viên cho Telegram, Instagram, YouTube, TikTok và hơn 60 nền tảng. Số dư USD trả trước nạp bằng TON, hoàn tiền tự động, giá theo số lượng lớn. Hoạt động trong Telegram và trên trình duyệt.' },
  zh: { title: 'GRAM Hub — 用 TON 支付的社交媒体推广', description: '为 Telegram、Instagram、YouTube、TikTok 等 60 多个平台提供粉丝、播放量、点赞和成员。预付 USD 余额，用 TON 充值，自动退款，批量优惠价。可在 Telegram 和浏览器中使用。' },
  ja: { title: 'GRAM Hub — TONで支払うSNSプロモーション', description: 'Telegram、Instagram、YouTube、TikTokなど60以上のプラットフォーム向けに、フォロワー、再生数、いいね、メンバーを提供。TONでチャージする前払いUSD残高、自動返金、まとめ買い価格。Telegramとブラウザで利用できます。' },
}

const fill = (template: string, vars: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)

/** The copy of a language the landing pages are written in; English for any other (a caller that serves a page checks LANDING_LANGS first). */
export const copyFor = (lang: LangCode): Copy => COPY[lang] ?? COPY.en!

/** What is on the page: the platform's name in that language, and the noun or flavour (with its noun) that is sold. */
function subject(lang: LangCode, landing: Extract<Landing, { type: 'service' }>): { platform: string; what: string } {
  const copy = copyFor(lang)
  const platform = copy.platformNames?.[landing.platform.slug] ?? landing.platform.name
  const flavored = landing.flavor ? copy.flavored[`${landing.flavor}-${landing.kind}` as keyof Copy['flavored']] : undefined
  const what = flavored ?? (landing.platform.slug === 'telegram' && landing.kind === 'followers' ? copy.telegramFollowers : copy.kinds[landing.kind])
  return { platform, what }
}

export interface PageText {
  h1: string
  title: string
  description: string
  intro: string
}

/** The heading, title, description and introduction of a page in a language. The home page has the title and description of HOME_META and no body here. */
export function pageText(lang: LangCode, landing: Landing): PageText {
  const copy = copyFor(lang)
  if (landing.type === 'home') {
    const meta = HOME_META[lang]
    return { h1: meta.title, title: meta.title, description: meta.description, intro: meta.description }
  }
  if (landing.type === 'topic') {
    const topic = copy.topics[landing.topic]
    return { h1: topic.h1, title: fill(copy.title, { h1: topic.h1 }), description: topic.description, intro: topic.intro }
  }
  const s = subject(lang, landing)
  const h1 = fill(copy.h1, s)
  return { h1, title: fill(copy.title, { h1 }), description: fill(copy.description, s), intro: fill(copy.intro, s) }
}

export const FLAVOR_LIST: readonly Flavor[] = ['premium', 'slow-auto', 'real']
export { LANDING_LANGS }
