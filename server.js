const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();
const app = express();
app.use(express.json());
const searchUI = {canvas:{content:{components:[{type:"text",text:"📚 Kolet Help Center",style:"header"},{type:"text",text:"Search articles to share with the customer",style:"muted"},{type:"spacer",size:"s"},{type:"input",id:"search_query",label:"Search",placeholder:"e.g. eSIM activation, data not working...",action:{type:"submit"}},{type:"button",id:"search_btn",label:"Search Articles",style:"primary",action:{type:"submit"}}]}}};
app.post('/intercom/initialize',(req,res)=>res.json(searchUI));
app.post('/intercom/submit',async(req,res)=>{
const query=req.body.input_values?.search_query;
if(req.body.component_id==='back_btn'||!query)return res.json(searchUI);
try{
const response=await fetch('https://api.intercom.io/articles',{headers:{Authorization:`Bearer ${process.env.INTERCOM_ACCESS_TOKEN}`,Accept:'application/json'}});
const data=await response.json();
const articles=(data.data||[]).filter(a=>a.title?.toLowerCase().includes(query.toLowerCase())||(a.description||'').toLowerCase().includes(query.toLowerCase())).slice(0,5);
const components=[{type:"text",text:`Results for "${query}"`,style:"header"},{type:"divider"}];
if(articles.length===0){components.push({type:"text",text:"No articles found. Try different keywords.",style:"muted"});}
else{for(const a of articles){components.push({type:"text",text:`📄 ${a.title}`,style:"paragraph"});if(a.url)components.push({type:"anchor",href:a.url,text:"Open article →"});components.push({type:"spacer",size:"xs"});}}
components.push({type:"divider"},{type:"button",id:"back_btn",label:"← New Search",style:"secondary",action:{type:"submit"}});
res.json({canvas:{content:{components}}});
}catch(err){console.error(err);res.json({canvas:{content:{components:[{type:"text",text:"⚠️ Something went wrong.",style:"muted"},{type:"button",id:"back_btn",label:"← Back",style:"secondary",action:{type:"submit"}}]}}});}
});
app.listen(process.env.PORT||3000,()=>console.log('✅ Kolet HC app running'));
