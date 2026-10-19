export type Prompt = { id: string; kind: "para" | "twister"; lang: "en" | "hi" | "gu"; title: string; lines: string[] };

const hindiA = [
  "Kal raat ko main der tak kaam kar raha tha, isliye aaj subah uthne mein thodi der ho gayi.",
  "Jaldi jaldi nahaya, chai banayi, aur phone dekha toh teen missed calls the, do mummy ke aur ek office se.",
  "Pehle mummy ko call kiya, unhone poocha ki khaana time pe kha raha hoon ya nahi, aur Sunday ko ghar kab aaunga.",
  "Maine kaha is Sunday mushkil hai, agle hafte pakka aaunga, aur aate waqt unke liye mithai bhi le aaunga.",
  "Phir office wale ko phone kiya, wo bole ki client ki meeting gyaarah baje se do baje shift ho gayi hai.",
  "Achha hua, kyunki mujhe presentation ke kuch slides abhi bhi theek karne the aur numbers dobara check karne the.",
  "Dopahar ko canteen mein rajma chawal mile, jo mujhe bahut pasand hain, toh mood thoda achha ho gaya.",
  "Meeting achhi gayi, client ne do teen sawaal poochhe, aur aakhir mein bola ki agle mahine se kaam shuru karte hain.",
];

const hindiB = [
  "Mere padosi Sharma uncle har roz subah paanch baje uthkar park mein ghoomne jaate hain.",
  "Unka kehna hai ki subah ki hawa sabse saaf hoti hai aur din bhar ki thakaan isi se door hoti hai.",
  "Kabhi kabhi main bhi unke saath chala jaata hoon, lekin aadhe raaste mein hi meri saans phool jaati hai.",
  "Uncle hanste hain aur kehte hain ki beta, tum log bas phone pe ungliyan chalate ho, pair bhi chalaya karo.",
  "Park ke bahar ek chaiwala hai jo adrak wali chai aur garam garam samose bechta hai.",
  "Wapas aate waqt hum dono wahan rukte hain, aur uncle mujhe purane zamaane ke kisse sunaate hain.",
];

const gujaratiA = [
  "Gaye athvaadiye amaari society ma Navratri ni taiyaari sharu thai gayi hati.",
  "Badha chhokra saanje saat vaagya pachhi garba ni practice karvaa bhega thata, ane mota loko khurshi par besi ne jota.",
  "Maari ben e navo chaNiyo choli lidho hato, ane te roj raate mane puchhti ke kevo laage chhe.",
  "Hu kahu ke saras laage chhe, pan te maanti j nahi, ane paachhi aynaa saame ubhi rahi jaati.",
  "Chhelle divase aakhi society e saathe jamvaanu raakhyu hatu, ane dar ghar thi ek vaangi aavi hati.",
  "Koi e dhokla, koi e khaandvi, ane koi e shrikhand puri banaavya hata, etle jamvaanu ekdam jordaar thayu.",
  "Raat na be vaagya sudhi garba chaalya, ane bije divase savaare koi j samaysar uthi na shakyu.",
];

const gujaratiB = [
  "Maara dada roj savaare chha vaagye uthi ne pahela bagicha ma chhod ne paani paay chhe.",
  "Pachhi te chhaapu vaanche chhe, ane dar samaachar par potaano abhipraay aape chhe, bhale koi saambhLe ke na saambhLe.",
  "Emne juna gito bahu game chhe, etle radio par Mukesh ane Rafi na gito vaagta j hoy.",
  "Bapore jamya pachhi te thoDi vaar oonghi jaay chhe, ane uthi ne maari saathe chess rame chhe.",
  "Hu ghani vaar jaani ne haari jaau chhu, kaaraN ke jeetya pachhi emno chahero joi ne bahu majaa aave chhe.",
];

export const prompts: Prompt[] = [
  { id: "p2-hi-a", kind: "para", lang: "hi", title: "Hindi paragraph 1 (typed in English)", lines: hindiA },
  { id: "p2-gu-a", kind: "para", lang: "gu", title: "Gujarati paragraph 1 (typed in English)", lines: gujaratiA },
  { id: "p2-hi-b", kind: "para", lang: "hi", title: "Hindi paragraph 2 (typed in English)", lines: hindiB },
  { id: "p2-gu-b", kind: "para", lang: "gu", title: "Gujarati paragraph 2 (typed in English)", lines: gujaratiB },
];
