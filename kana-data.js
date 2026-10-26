/* Hiragana reference data for Kotoba.
   Each kana: [character, romaji, sounds-like, optional note]
   Sounds-like follows the phrasebook rule: a = ah, i = ee, u = oo, e = eh, o = oh. */
window.KANA_DATA = {
  tiers: [
    {
      id: 'basic', name: 'Basic 46', jp: 'ごじゅうおん', desc: 'The core hiragana. Learn these first.',
      rows: [
        { name: 'あ row', kana: [['あ','a','ah'],['い','i','ee'],['う','u','oo'],['え','e','eh'],['お','o','oh']] },
        { name: 'か row', kana: [['か','ka','kah'],['き','ki','kee'],['く','ku','koo'],['け','ke','keh'],['こ','ko','koh']] },
        { name: 'さ row', kana: [['さ','sa','sah'],['し','shi','shee','Not "si" — it\'s "shi".'],['す','su','soo'],['せ','se','seh'],['そ','so','soh']] },
        { name: 'た row', kana: [['た','ta','tah'],['ち','chi','chee','Not "ti" — it\'s "chi".'],['つ','tsu','tsoo','Not "tu" — it\'s "tsu".'],['て','te','teh'],['と','to','toh']] },
        { name: 'な row', kana: [['な','na','nah'],['に','ni','nee'],['ぬ','nu','noo'],['ね','ne','neh'],['の','no','noh']] },
        { name: 'は row', kana: [['は','ha','hah','Read "wa" when it marks the topic: わたしは.'],['ひ','hi','hee'],['ふ','fu','foo','Soft, between "fu" and "hu".'],['へ','he','heh','Read "e" when it means "toward".'],['ほ','ho','hoh']] },
        { name: 'ま row', kana: [['ま','ma','mah'],['み','mi','mee'],['む','mu','moo'],['め','me','meh'],['も','mo','moh']] },
        { name: 'や row', kana: [['や','ya','yah'],['ゆ','yu','yoo'],['よ','yo','yoh']] },
        { name: 'ら row', kana: [['ら','ra','rah','Between an English r and l.'],['り','ri','ree'],['る','ru','roo'],['れ','re','reh'],['ろ','ro','roh']] },
        { name: 'わ row', kana: [['わ','wa','wah'],['を','wo','oh','Only used as the object particle; pronounced "o".'],['ん','n','n','The only kana with no vowel, like the n in "sun".']] },
      ],
    },
    {
      id: 'dakuten', name: 'Dakuten', jp: 'だくおん', desc: 'Two small marks (゛) or a circle (゜) change the sound.', requires: 'basic',
      rows: [
        { name: 'が row', kana: [['が','ga','gah'],['ぎ','gi','gee','Hard g, as in "geese".'],['ぐ','gu','goo'],['げ','ge','geh'],['ご','go','goh']] },
        { name: 'ざ row', kana: [['ざ','za','zah'],['じ','ji','jee'],['ず','zu','zoo'],['ぜ','ze','zeh'],['ぞ','zo','zoh']] },
        { name: 'だ row', kana: [['だ','da','dah'],['ぢ','ji','jee','Rare; sounds the same as じ.'],['づ','zu','zoo','Rare; sounds the same as ず.'],['で','de','deh'],['ど','do','doh']] },
        { name: 'ば row', kana: [['ば','ba','bah'],['び','bi','bee'],['ぶ','bu','boo'],['べ','be','beh'],['ぼ','bo','boh']] },
        { name: 'ぱ row', kana: [['ぱ','pa','pah'],['ぴ','pi','pee'],['ぷ','pu','poo'],['ぺ','pe','peh'],['ぽ','po','poh']] },
      ],
    },
    {
      id: 'combo', name: 'Combos', jp: 'ようおん', desc: 'A kana plus a small ゃ ゅ ょ blends into one syllable.', requires: 'dakuten',
      rows: [
        { name: 'きゃ row', kana: [['きゃ','kya','kyah'],['きゅ','kyu','kyoo'],['きょ','kyo','kyoh']] },
        { name: 'しゃ row', kana: [['しゃ','sha','shah'],['しゅ','shu','shoo'],['しょ','sho','shoh']] },
        { name: 'ちゃ row', kana: [['ちゃ','cha','chah'],['ちゅ','chu','choo'],['ちょ','cho','choh']] },
        { name: 'にゃ row', kana: [['にゃ','nya','nyah'],['にゅ','nyu','nyoo'],['にょ','nyo','nyoh']] },
        { name: 'ひゃ row', kana: [['ひゃ','hya','hyah'],['ひゅ','hyu','hyoo'],['ひょ','hyo','hyoh']] },
        { name: 'みゃ row', kana: [['みゃ','mya','myah'],['みゅ','myu','myoo'],['みょ','myo','myoh']] },
        { name: 'りゃ row', kana: [['りゃ','rya','ryah'],['りゅ','ryu','ryoo'],['りょ','ryo','ryoh']] },
        { name: 'ぎゃ row', kana: [['ぎゃ','gya','gyah'],['ぎゅ','gyu','gyoo'],['ぎょ','gyo','gyoh']] },
        { name: 'じゃ row', kana: [['じゃ','ja','jah'],['じゅ','ju','joo'],['じょ','jo','joh']] },
        { name: 'びゃ row', kana: [['びゃ','bya','byah'],['びゅ','byu','byoo'],['びょ','byo','byoh']] },
        { name: 'ぴゃ row', kana: [['ぴゃ','pya','pyah'],['ぴゅ','pyu','pyoo'],['ぴょ','pyo','pyoh']] },
      ],
    },
  ],
};
