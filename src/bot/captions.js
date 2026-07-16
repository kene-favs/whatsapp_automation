// Auto-rotating captions per business type — no AI needed
// Rotates by day-of-year so each day gets a fresh caption automatically

const CAPTIONS = {
  salon: [
    "💇‍♀️ Looking fresh starts here. Book your session today — DM us now!",
    "✨ Your hair deserves the best hands. Visit us today!",
    "👑 Queen, you deserve to slay every day. Let us do the magic!",
    "💅 New week, new look! Walk in or book ahead — we're ready for you.",
    "🌟 Good hair days start at our salon. Chat us to reserve your spot!",
    "💆‍♀️ Treat yourself today. You deserve that fresh feeling!",
    "🔥 Hot styles, better prices. DM us to see our full menu.",
    "🌸 Every style is unique — just like you. Book your appointment now!",
    "✂️ Precision cuts & styles that turn heads. We're open today!",
    "💜 Confidence starts at the crown. Let us style you right!",
    "🙌 Your transformation is one appointment away. Let's go!",
    "💃 Slay your week right — start with a fresh look from us!",
    "🌺 We don't just do hair, we create confidence. Book now!",
    "⭐ Satisfied clients are our best advertisement. Join the family!",
    "💕 Beauty is not just looks — it's how you feel. Feel amazing today!"
  ],
  food: [
    "🍽️ Hot food, real taste — delivered or ready for pickup. Order now!",
    "🔥 Freshly made with love every single day. DM us your order!",
    "😋 Hunger is calling. Let us answer it! Chat us to order.",
    "🍛 Real Nigerian food, real love in every plate. Order today!",
    "🥘 Nothing beats a homemade meal. We make it taste like home.",
    "🍱 Hot, fresh, and delicious — always ready for you!",
    "😍 Your next favourite meal is just one message away.",
    "🍲 Eat well, live well. Our meals are made fresh daily!",
    "🥩 Taste the difference quality makes. Order your food today!",
    "🍜 Food that hits different — every time. DM us!",
    "❤️ We cook with real ingredients and real love. No shortcuts!",
    "🌯 Hunger is not an option with us. We deliver fast!",
    "🍖 Bold flavours, satisfying portions. This is how food should be.",
    "🌟 Fresh today, delicious today — that's our promise to you.",
    "🙏 Thank you for choosing us. Your next order is waiting!"
  ],
  fashion: [
    "👗 New arrivals just dropped! Slide into our DMs to shop.",
    "✨ Style is a way of saying who you are without speaking.",
    "🛍️ Fresh pieces, amazing prices. Ask us what's available today!",
    "👑 Dress like the royalty you are. Check our new collection!",
    "🔥 Trending styles, your budget — DM us now!",
    "💫 Elevate your wardrobe today. New items are in stock!",
    "🌸 Beautiful outfits that speak for you. Chat us to browse.",
    "💜 You deserve to look amazing every day. We make it easy!",
    "🎀 Find your signature style with us. New pieces available!",
    "✨ Fashion is not just clothes — it's confidence.",
    "👒 Slay every event, every day. Shop our latest arrivals!",
    "🛒 Your next favourite outfit is waiting in our store. DM us!",
    "💃 Look good, feel great — that's what we're here for.",
    "🌟 Style that turns heads, prices that make sense. Ask us!",
    "❤️ Dress well, feel well, live well. Shop with us today!"
  ],
  cosmetics: [
    "💄 Glow different. Our products work — ask our clients!",
    "✨ Skincare that actually delivers results. DM us to order!",
    "💅 Your skin deserves the best. We stock only quality products!",
    "🌸 Radiant skin, confident you — start your routine today!",
    "👑 Real beauty starts with real products. Check our catalogue!",
    "💆‍♀️ Treat your skin right. Our range is here to help!",
    "✨ Glow from within — our skincare line makes it easy.",
    "🌟 Flawless skin is not luck — it's the right products.",
    "💕 Because you deserve to feel beautiful every single day.",
    "🔥 Top quality cosmetics at prices you'll love. DM us!",
    "🛍️ New stock just arrived! Slide in to see what's new.",
    "💜 Confidence in a bottle. Find it with our product range.",
    "🌺 Your glow-up starts here. Ask us for recommendations!",
    "💖 Real products, real results — no filters needed!",
    "✨ Beautiful skin is possible. Let us help you get there!"
  ],
  general: [
    "👋 We're open and ready to serve you today! DM us anytime.",
    "✨ Quality products, great service — that's our standard!",
    "🔥 Hot deals available today. Don't miss out — chat us now!",
    "🙌 Thank you to all our amazing customers. We appreciate you!",
    "⭐ Your satisfaction is our top priority. How can we help?",
    "💫 Good things are waiting for those who DM us today!",
    "🌟 We're here to serve you — morning, afternoon, and evening.",
    "💪 Committed to giving you the best every single time.",
    "❤️ We love our customers. Let us show you how we serve!",
    "🛍️ Whether you're browsing or ready to buy — we're here!",
    "✅ Reliable, fast, and friendly service. That's ForgeBot clients!",
    "🌸 New week, fresh opportunities. Shop or inquire today!",
    "🔔 Don't miss our latest updates! Stay tuned to this status.",
    "💬 Got questions? We've got answers. Just DM us!",
    "🙏 Thank you for your continued trust and support!"
  ]
};

function getCaption(businessType) {
  const type = businessType?.toLowerCase() || 'general';
  const pool = CAPTIONS[type] || CAPTIONS.general;
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return pool[dayOfYear % pool.length];
}

module.exports = { CAPTIONS, getCaption };
