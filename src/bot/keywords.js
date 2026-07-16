const KEYWORDS = {
  greeting: [
    'hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening',
    'good day', 'how are you', 'how you dey', 'how far', 'oga', 'madam',
    'abeg', 'please', 'pls', 'greetings', 'sup', 'watsup',
    'hiya', 'yo', 'morning', 'afternoon', 'evening', 'night', 'howdy'
  ],
  price: [
    'price', 'cost', 'how much', 'price list', 'pricelist', 'rate', 'rates',
    'how much e cost', 'wetin be the price', 'how much be', 'fee', 'charge',
    'amount', 'quote', 'budget', 'afford', 'cheap', 'expensive', 'pricing',
    'cost me', 'price of', 'price for', 'what is the price', 'e cost how much'
  ],
  availability: [
    'available', 'availability', 'in stock', 'do you have', 'you get am',
    'still available', 'still in stock', 'left', 'remaining', 'stock',
    'out of stock', 'when will you have', 'when e go dey', 'you still get',
    'any available', 'is it available', 'do you still have', 'got any'
  ],
  order: [
    'order', 'i want to order', 'i wan order', 'make order', 'place order',
    'buy', 'purchase', 'book', 'booking', 'reserve', 'reservation',
    'i want to buy', 'i wan buy', 'how to order', 'can i order',
    'interested', 'i dey interested', 'take my order', 'let me order'
  ],
  delivery: [
    'delivery', 'deliver', 'shipping', 'ship', 'how long delivery', 'when deliver',
    'send to me', 'how long does it take', 'dispatch', 'pickup', 'pick up',
    'bring', 'drop off', 'collect', 'delivery time', 'when will it arrive',
    'door delivery', 'nationwide', 'location delivery', 'tracking', 'rider'
  ],
  location: [
    'location', 'where are you', 'address', 'where you dey', 'your address',
    'where is your shop', 'where is your store', 'google map', 'directions',
    'how to get there', 'are you on google map', 'find you', 'near me',
    'state', 'city', 'lagos', 'abuja', 'ph', 'port harcourt', 'ibadan'
  ],
  payment: [
    'payment', 'how to pay', 'payment method', 'pay how', 'how i go pay',
    'bank account', 'transfer', 'account number', 'bank details', 'acct',
    'opay', 'palmpay', 'moniepoint', 'gtb', 'first bank', 'access bank',
    'zenith', 'kuda', 'pos', 'cash', 'card', 'pay with card', 'ussd'
  ],
  payment_claim: [
    'i have paid', 'i don pay', 'i paid', 'payment done', 'payment sent',
    'i just paid', 'i transferred', 'i sent the money', 'check your account',
    'i don send am', 'i send am', 'na pay i pay', 'transfer done',
    'payment complete', 'i made payment', 'see my receipt', 'i have made payment',
    'money sent', 'i don do transfer', 'alert don drop', 'i don transfer',
    'abeg check', 'check account', 'payment successfull', 'i pay already'
  ],
  product_info: [
    'what do you sell', 'what you dey sell', 'your products', 'your services',
    'what services', 'product list', 'catalogue', 'catalog', 'menu',
    'tell me about', 'info', 'information', 'details', 'describe',
    'specification', 'spec', 'what you get', 'what you offer', 'offerings'
  ],
  thanks: [
    'thank you', 'thanks', 'thank u', 'thx', 'tnx', 'tnks', 'thnx',
    'appreciate', 'appreciated', 'e don', 'okay', 'ok', 'alright', 'noted',
    'great', 'perfect', 'wonderful', 'amazing', 'excellent', 'nice', 'good'
  ],
  complaint: [
    'complain', 'complaint', 'not working', 'broken', 'bad', 'disappointed',
    'terrible', 'worst', 'refund', 'return', 'fake', 'wrong item',
    'i no like', 'i dey vex', 'annoyed', 'angry', 'this is bad',
    'not satisfied', 'poor service', 'bad service', 'issue', 'problem'
  ],
  contact: [
    'contact', 'call', 'phone number', 'phone no', 'number', 'email',
    'whatsapp number', 'how to reach you', 'reach you', 'get in touch',
    'talk to', 'connect with', 'your contact', 'support', 'help line'
  ],
  human_handoff: [
    'speak to human', 'talk to human', 'real person', 'speak to someone',
    'talk to agent', 'connect me', 'i want to talk', 'speak to owner',
    'talk to owner', 'human please', 'abeg connect me', 'give me human',
    'i want owner', 'customer service', 'customer care', 'live agent',
    'actual person', 'not bot', 'no bot', 'human being', 'speak to staff',
    'talk to staff', 'i need human', 'i need a person'
  ]
};

function matchKeyword(text) {
  const lower = text.toLowerCase().trim();
  for (const category in KEYWORDS) {
    const keywords = KEYWORDS[category];
    if (keywords.some(function(kw) { return lower.includes(kw); })) {
      return category;
    }
  }
  return null;
}

module.exports = { KEYWORDS, matchKeyword };
