/**
 * veld-engine.js — Veld Language Engine v1.4
 *
 * Self-contained, DOM-free JavaScript module.
 * No external dependencies. Works in browsers and Node.js.
 *
 * Exports (UMD-compatible, also works as plain <script>):
 *   tokenize(src)         → Token[]
 *   Parser                → class
 *   Interpreter           → class
 *   Env                   → class
 *   lint(src)             → Issue[]
 *   typeCheck(ast)        → Warning[]
 *   LexError, ParseError, VeldError
 *   ReturnSignal, BreakSignal, ContinueSignal
 *   TT, KEYWORDS, BUILTINS
 *
 * Interpreter constructor:
 *   new Interpreter(outputFn, ffi, options?)
 *
 *   options.scheduleFrame(fn)  — default: requestAnimationFrame
 *   options.onLoopStart(stopFn) — called when loop frame begins
 *   options.onLoopStop()        — called when loop frame ends
 *
 *   localStorage is used by export/import module statements.
 *   These are browser-only statements; engine will throw gracefully in Node.
 *
 * Usage:
 *   const tokens = tokenize(src);
 *   const ast = new Parser(tokens).parseProgram();
 *   const interp = new Interpreter(text => console.log(text), {}, {
 *     scheduleFrame: requestAnimationFrame,
 *     onLoopStart: (stop) => { window.__stopFn = stop; },
 *     onLoopStop: () => { /* hide stop button *\/ },
 *   });
 *   interp.run(ast);
 */

(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    const exp = factory();
    Object.assign(root, exp);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {

// ── TOKEN TYPES ─────────────────────────────────────────
const TT = {
  NUM:'NUM', STR:'STR', BOOL:'BOOL', NIL:'NIL',
  IDENT:'IDENT', KW:'KW', OP:'OP',
  LPAREN:'LPAREN', RPAREN:'RPAREN',
  LBRACE:'LBRACE', RBRACE:'RBRACE',
  LBRACKET:'LBRACKET', RBRACKET:'RBRACKET',
  COMMA:'COMMA', COLON:'COLON',
  ARROW:'ARROW', NEWLINE:'NEWLINE', EOF:'EOF', PIPE:'PIPE', DOT:'DOT',
};
const KEYWORDS = new Set([
  'let','const','fn','return','if','else','while','for','in',
  'match','true','false','nil','and','or','not','print','println',
  'type','import','export','as','break','continue','struct','module','use',
  'async','await','loop',
  'Int','Float','Bool','Str','List','Any',
]);
const BUILTINS = new Set([
  'len','range','push','pop','join','split','to_int','to_float',
  'to_str','to_bool','floor','ceil','abs','min','max','sqrt','type_of',
]);

// ── LEXER ───────────────────────────────────────────────
class LexError extends Error { constructor(m,l,c){super(m);this.line=l;this.col=c;} }

function tokenize(src) {
  const tokens=[]; let i=0,line=1,col=1;
  const peek=(o=0)=>src[i+o];
  function adv(){const c=src[i++];if(c==='\n'){line++;col=1;}else col++;return c;}
  function addTok(type,val,l,c){tokens.push({type,val,line:l!==undefined?l:line,col:c!==undefined?c:col});}
  while(i<src.length){
    const c=peek(),l=line,cl=col;
    if(c===' '||c==='\t'||c==='\r'){adv();continue;}
    if(c==='\n'){adv();addTok(TT.NEWLINE,'\n',l,cl);continue;}
    if(c==='#'){while(i<src.length&&peek()!=='\n')adv();continue;}
    if(c==='"'||c==="'"){
      const q=adv();let s='';
      while(i<src.length&&peek()!==q){
        if(peek()==='\\'){adv();const e=adv();
          if(e==='n')s+='\n';else if(e==='t')s+='\t';else if(e==='"')s+='"';else if(e==="'")s+="'";else if(e==='\\')s+='\\';else s+=e;
        }else s+=adv();
      }
      if(i>=src.length||peek()!==q)throw new LexError(`Unterminated string`,l,cl);
      adv();addTok(TT.STR,s,l,cl);continue;
    }
    if(c>='0'&&c<='9'){
      let n='',isF=false;
      while(i<src.length&&((peek()>='0'&&peek()<='9')||peek()==='.')) {
        if(peek()==='.'){if(src[i+1]==='.')break;if(isF)break;isF=true;}
        n+=adv();
      }
      addTok(TT.NUM,isF?parseFloat(n):parseInt(n,10),l,cl);continue;
    }
    if((c>='a'&&c<='z')||(c>='A'&&c<='Z')||c==='_'){
      let id='';
      while(i<src.length&&((peek()>='a'&&peek()<='z')||(peek()>='A'&&peek()<='Z')||(peek()>='0'&&peek()<='9')||peek()==='_'))id+=adv();
      if(id==='true'||id==='false')addTok(TT.BOOL,id==='true',l,cl);
      else if(id==='nil')addTok(TT.NIL,null,l,cl);
      else if(KEYWORDS.has(id))addTok(TT.KW,id,l,cl);
      else addTok(TT.IDENT,id,l,cl);
      continue;
    }
    const two=src.slice(i,i+2);
    if(two==='->'){i+=2;col+=2;addTok(TT.ARROW,'->',l,cl);continue;}
    if(['==','!=','<=','>=','**','&&','||','..','+=','-=','*=','/=','%='].includes(two)){i+=2;col+=2;addTok(TT.OP,two,l,cl);continue;}
    if(two==='//'){i+=2;col+=2;addTok(TT.OP,'//',l,cl);continue;}
    const singles={'(':TT.LPAREN,')':TT.RPAREN,'{':TT.LBRACE,'}':TT.RBRACE,'[':TT.LBRACKET,']':TT.RBRACKET,',':TT.COMMA,':':TT.COLON,'.':TT.DOT,'|':TT.PIPE};
    if(singles[c]){adv();addTok(singles[c],c,l,cl);continue;}
    if('+-*/<>=!%'.includes(c)){adv();addTok(TT.OP,c,l,cl);continue;}
    throw new LexError(`Unexpected character '${c}'`,l,cl);
  }
  addTok(TT.EOF,null,line,col);
  return tokens;
}

// ── PARSER ──────────────────────────────────────────────
class ParseError extends Error { constructor(m,t){super(m);this.token=t;this.line=t?t.line:null;this.col=t?t.col:null;} }

class Parser {
  constructor(tokens){this.tokens=tokens.filter(t=>t.type!==TT.NEWLINE);this.pos=0;}
  peek(o=0){return this.tokens[Math.min(this.pos+o,this.tokens.length-1)];}
  eat(type,val){const t=this.peek();if(type&&t.type!==type)throw new ParseError(`Expected ${type} but got '${t.val}'`,t);if(val!==undefined&&t.val!==val)throw new ParseError(`Expected '${val}' but got '${t.val}'`,t);this.pos++;return t;}
  check(type,val){const t=this.peek();return t.type===type&&(val===undefined||t.val===val);}
  match(...pairs){for(const[type,val]of pairs){if(this.check(type,val))return this.eat(type,val);}return null;}
  parseProgram(){const stmts=[];while(!this.check(TT.EOF))stmts.push(this.parseStmt());return{node:'Program',body:stmts};}
  parseStmt(){
    const t=this.peek();
    if(t.type===TT.KW){switch(t.val){
      case 'let':case 'const':return this.parseVar();
      case 'fn':return this.parseFn();
      case 'async':return this.parseAsyncFn();
      case 'export':return this.parseExport();
      case 'return':return this.parseReturn();
      case 'if':return this.parseIf();
      case 'while':return this.parseWhile();
      case 'for':return this.parseFor();
      case 'match':return this.parseMatch();
      case 'print':case 'println':return this.parsePrint();
      case 'break':this.eat();return{node:'Break'};
      case 'continue':this.eat();return{node:'Continue'};
      case 'type':return this.parseTypeAlias();
      case 'struct':return this.parseStruct();
      case 'module':return this.parseModule();
      case 'use':return this.parseUse();
      case 'import':return this.parseImport();
      case 'loop':return this.parseLoop();
    }}
    if(t.type===TT.IDENT&&t.val==='impl')return this.parseImpl();
    return{node:'ExprStmt',expr:this.parseExpr()};
  }
  parseVar(){
    const kw=this.eat(TT.KW);
    if(this.check(TT.LBRACE)){
      this.eat(TT.LBRACE);const names=[];
      while(!this.check(TT.RBRACE)&&!this.check(TT.EOF)){const field=this.eat(TT.IDENT);let alias=field.val;if(this.match([TT.COLON]))alias=this.eat(TT.IDENT).val;names.push({field:field.val,alias});this.match([TT.COMMA]);}
      this.eat(TT.RBRACE);this.eat(TT.OP,'=');const val=this.parseExpr();
      return{node:'DestructureDecl',kind:'struct',kind2:kw.val,names,val,line:kw.line};
    }
    if(this.check(TT.LBRACKET)){
      this.eat(TT.LBRACKET);const names=[];let rest=null;
      while(!this.check(TT.RBRACKET)&&!this.check(TT.EOF)){
        if(this.peek().val==='..'&&this.peek().type===TT.OP){this.eat();rest=this.eat(TT.IDENT).val;break;}
        names.push(this.eat(TT.IDENT).val);this.match([TT.COMMA]);
      }
      this.eat(TT.RBRACKET);this.eat(TT.OP,'=');const val=this.parseExpr();
      return{node:'DestructureDecl',kind:'list',kind2:kw.val,names,rest,val,line:kw.line};
    }
    const name=this.eat(TT.IDENT);let typeAnn=null;
    if(this.match([TT.COLON,undefined])){const t=this.peek();if(t.type===TT.IDENT||t.type===TT.KW){this.eat();typeAnn=t.val;}else throw new ParseError(`Expected type name after ':'`,t);}
    this.eat(TT.OP,'=');const val=this.parseExpr();
    return{node:'VarDecl',kind:kw.val,name:name.val,typeAnn,val,line:kw.line,col:kw.col};
  }
  parseFn(){
    const kw=this.eat(TT.KW,'fn');const name=this.eat(TT.IDENT);this.eat(TT.LPAREN);
    const params=[];
    while(!this.check(TT.RPAREN)){const p=this.eat(TT.IDENT);let pType=null;if(this.match([TT.COLON])){const pt=this.peek();if(pt.type===TT.IDENT||pt.type===TT.KW){this.eat();pType=pt.val;}}params.push({name:p.val,type:pType});if(!this.check(TT.RPAREN))this.eat(TT.COMMA);}
    this.eat(TT.RPAREN);let retType=null;
    if(this.check(TT.ARROW)){this.eat();const rt=this.peek();if(rt.type===TT.IDENT||rt.type===TT.KW){this.eat();retType=rt.val;}}
    return{node:'FnDecl',name:name.val,params,retType,body:this.parseBlock(),line:kw.line};
  }
  parseReturn(){const kw=this.eat(TT.KW,'return');return{node:'Return',val:this.check(TT.RBRACE)?null:this.parseExpr(),line:kw.line};}
  parseIf(){const kw=this.eat(TT.KW,'if');const cond=this.parseExpr();const then=this.parseBlock();let elseB=null;if(this.check(TT.KW,'else')){this.eat();if(this.check(TT.KW,'if'))elseB=this.parseIf();else elseB=this.parseBlock();}return{node:'If',cond,then,else:elseB,line:kw.line};}
  parseWhile(){const kw=this.eat(TT.KW,'while');return{node:'While',cond:this.parseExpr(),body:this.parseBlock(),line:kw.line};}
  parseFor(){const kw=this.eat(TT.KW,'for');const iter=this.eat(TT.IDENT);this.eat(TT.KW,'in');return{node:'For',iter:iter.val,src:this.parseExpr(),body:this.parseBlock(),line:kw.line};}
  parseMatch(){return this.parseMatchExpr();}
  parseIfExpr(){const kw=this.eat(TT.KW,'if');const cond=this.parseExpr();const then=this.parseBlock();if(!this.check(TT.KW,'else'))throw new ParseError(`if-expression requires an 'else' branch`,this.peek());this.eat(TT.KW,'else');let elseB;if(this.check(TT.KW,'if'))elseB=this.parseIfExpr();else elseB=this.parseBlock();return{node:'IfExpr',cond,then,else:elseB,line:kw.line};}
  parseMatchExpr(){
    const kw=this.eat(TT.KW,'match');const val=this.parseExpr();this.eat(TT.LBRACE);const arms=[];
    while(!this.check(TT.RBRACE)&&!this.check(TT.EOF)){const pat=this.parsePat();this.eat(TT.ARROW);const body=this.check(TT.LBRACE)?this.parseBlock():this.parseExpr();arms.push({pat,body});}
    this.eat(TT.RBRACE);return{node:'Match',val,arms,line:kw.line};
  }
  parsePat(){
    if(this.check(TT.IDENT,'_')){this.eat();return{node:'WildPat'};}
    if(this.peek().type===TT.IDENT&&this.peek(1).type===TT.LBRACE){
      const sname=this.eat(TT.IDENT).val;this.eat(TT.LBRACE);const bindings=[];
      while(!this.check(TT.RBRACE)&&!this.check(TT.EOF)){const field=this.eat(TT.IDENT);let alias=field.val;if(this.match([TT.COLON]))alias=this.eat(TT.IDENT).val;bindings.push({field:field.val,alias});this.match([TT.COMMA]);}
      this.eat(TT.RBRACE);return{node:'StructPat',structName:sname,bindings};
    }
    return{node:'LitPat',val:this.parseExpr()};
  }
  parseImpl(){
    this.eat(TT.IDENT);const name=this.eat(TT.IDENT).val;this.eat(TT.LBRACE);const methods=[];
    while(!this.check(TT.RBRACE)&&!this.check(TT.EOF)){
      this.eat(TT.KW,'fn');const mname=this.eat(TT.IDENT).val;this.eat(TT.LPAREN);const params=[];
      while(!this.check(TT.RPAREN)){const p=this.eat(TT.IDENT);let pType=null;if(this.match([TT.COLON])){const pt=this.peek();if(pt.type===TT.IDENT||pt.type===TT.KW){this.eat();pType=pt.val;}}params.push({name:p.val,type:pType});if(!this.check(TT.RPAREN))this.eat(TT.COMMA);}
      this.eat(TT.RPAREN);let retType=null;if(this.check(TT.ARROW)){this.eat();const rt=this.peek();if(rt.type===TT.IDENT||rt.type===TT.KW){this.eat();retType=rt.val;}}
      methods.push({name:mname,params,retType,body:this.parseBlock()});
    }
    this.eat(TT.RBRACE);return{node:'ImplDecl',structName:name,methods};
  }
  parseModule(){const kw=this.eat(TT.KW,'module');const name=this.eat(TT.IDENT).val;return{node:'ModuleDecl',name,body:this.parseBlock(),line:kw.line};}
  parseUse(){const kw=this.eat(TT.KW,'use');return{node:'UseDecl',name:this.eat(TT.IDENT).val,line:kw.line};}
  parseLoop(){const kw=this.eat(TT.KW,'loop');const t=this.peek();if(!(t.type===TT.IDENT||t.type===TT.KW))throw new ParseError(`Expected 'frame' after 'loop'`,t);const mode=this.eat().val;if(mode!=='frame')throw new ParseError(`Expected 'frame' after 'loop'`,t);const body=this.parseBlock();return{node:'LoopFrame',body,line:kw.line};}
  parseAsyncFn(){
    const kw=this.eat(TT.KW,'async');this.eat(TT.KW,'fn');const name=this.eat(TT.IDENT);this.eat(TT.LPAREN);
    const params=[];
    while(!this.check(TT.RPAREN)){const p=this.eat(TT.IDENT);let pType=null;if(this.match([TT.COLON])){const pt=this.peek();if(pt.type===TT.IDENT||pt.type===TT.KW){this.eat();pType=pt.val;}}params.push({name:p.val,type:pType});if(!this.check(TT.RPAREN))this.eat(TT.COMMA);}
    this.eat(TT.RPAREN);let retType=null;
    if(this.check(TT.ARROW)){this.eat();const rt=this.peek();if(rt.type===TT.IDENT||rt.type===TT.KW){this.eat();retType=rt.val;}}
    return{node:'FnDecl',name:name.val,params,retType,body:this.parseBlock(),line:kw.line,isAsync:true};
  }
  parseExport(){
    const kw=this.eat(TT.KW,'export');
    if(this.check(TT.KW,'module')){this.eat(TT.KW,'module');const name=this.eat(TT.IDENT);return{node:'ExportModule',name:name.val,line:kw.line};}
    throw new ParseError(`Expected 'module' after 'export'`,this.peek());
  }
  parseImport(){
    const kw=this.eat(TT.KW,'import');const name=this.eat(TT.IDENT);
    return{node:'ImportModule',name:name.val,line:kw.line};
  }
  parsePrint(){const kw=this.eat(TT.KW);this.eat(TT.LPAREN);const args=[];while(!this.check(TT.RPAREN)){args.push(this.parseExpr());if(!this.check(TT.RPAREN))this.eat(TT.COMMA);}this.eat(TT.RPAREN);return{node:'Print',newline:kw.val==='println',args,line:kw.line};}
  parseTypeAlias(){this.eat(TT.KW,'type');const name=this.eat(TT.IDENT);this.eat(TT.OP,'=');return{node:'TypeAlias',name:name.val,alias:this.eat(TT.IDENT).val};}
  parseStruct(){const kw=this.eat(TT.KW,'struct');const name=this.eat(TT.IDENT);this.eat(TT.LBRACE);const fields=[];while(!this.check(TT.RBRACE)&&!this.check(TT.EOF)){const fname=this.eat(TT.IDENT);let ftype='Any';if(this.match([TT.COLON])){const ft=this.peek();if(ft.type===TT.IDENT||ft.type===TT.KW){this.eat();ftype=ft.val;}}fields.push({name:fname.val,type:ftype});this.match([TT.COMMA]);}this.eat(TT.RBRACE);return{node:'StructDecl',name:name.val,fields,line:kw.line};}
  parseBlock(){this.eat(TT.LBRACE);const stmts=[];while(!this.check(TT.RBRACE)&&!this.check(TT.EOF))stmts.push(this.parseStmt());this.eat(TT.RBRACE);return{node:'Block',body:stmts};}
  parseExpr(){return this.parseAssign();}
  parseAssign(){
    const l=this.parseOr();
    if(this.check(TT.OP,'=')&&l.node==='Ident'){const op=this.eat();return{node:'Assign',name:l.name,val:this.parseExpr(),line:op.line};}
    const cmpOps=['+=','-=','*=','/=','%='];
    if(cmpOps.includes(this.peek().val)&&l.node==='Ident'){const op=this.eat();const r=this.parseExpr();return{node:'Assign',name:l.name,val:{node:'BinOp',op:op.val[0],left:l,right:r,line:op.line},line:op.line};}
    return l;
  }
  parseOr(){let l=this.parseAnd();while(this.check(TT.KW,'or')||this.check(TT.OP,'||')){const op=this.eat();l={node:'BinOp',op:'or',left:l,right:this.parseAnd(),line:op.line};}return l;}
  parseAnd(){let l=this.parseEq();while(this.check(TT.KW,'and')||this.check(TT.OP,'&&')){const op=this.eat();l={node:'BinOp',op:'and',left:l,right:this.parseEq(),line:op.line};}return l;}
  parseEq(){let l=this.parseCmp();while(['==','!='].includes(this.peek().val)&&this.peek().type===TT.OP){const op=this.eat();l={node:'BinOp',op:op.val,left:l,right:this.parseCmp(),line:op.line};}return l;}
  parseCmp(){let l=this.parseRange();while(['<','>','<=','>='].includes(this.peek().val)&&this.peek().type===TT.OP){const op=this.eat();l={node:'BinOp',op:op.val,left:l,right:this.parseRange(),line:op.line};}return l;}
  parseRange(){let l=this.parseAdd();if(this.peek().val==='..'&&this.peek().type===TT.OP){const op=this.eat();return{node:'Range',start:l,end:this.parseAdd(),line:op.line};}return l;}
  parseAdd(){let l=this.parseMul();while(['+','-'].includes(this.peek().val)&&this.peek().type===TT.OP){const op=this.eat();l={node:'BinOp',op:op.val,left:l,right:this.parseMul(),line:op.line};}return l;}
  parseMul(){let l=this.parseUnary();while(['*','/','//','%','**'].includes(this.peek().val)&&this.peek().type===TT.OP){const op=this.eat();l={node:'BinOp',op:op.val,left:l,right:this.parseUnary(),line:op.line};}return l;}
  parseUnary(){if(this.check(TT.OP,'-')||this.check(TT.OP,'!')||this.check(TT.KW,'not')){const op=this.eat();return{node:'UnaryOp',op:op.val,val:this.parseUnary(),line:op.line};}if(this.check(TT.KW,'await')){const op=this.eat();return{node:'Await',val:this.parseUnary(),line:op.line};}return this.parsePostfix();}
  parsePostfix(){
    let e=this.parsePrimary();
    while(true){
      if(this.check(TT.LPAREN)){this.eat();const args=[];while(!this.check(TT.RPAREN)){args.push(this.parseExpr());if(!this.check(TT.RPAREN))this.eat(TT.COMMA);}this.eat(TT.RPAREN);e={node:'Call',callee:e,args,line:e.line};}
      else if(this.check(TT.LBRACKET)){const op=this.eat();const idx=this.parseExpr();this.eat(TT.RBRACKET);e={node:'Index',target:e,idx,line:op.line};}
      else if(this.check(TT.DOT)){const op=this.eat();const prop=(this.peek().type===TT.IDENT||this.peek().type===TT.KW)?this.eat():this.eat(TT.IDENT);e={node:'Dot',target:e,prop:prop.val,line:op.line};}
      else break;
    }
    return e;
  }
  parsePrimary(){
    const t=this.peek();
    if(t.type===TT.NUM){this.eat();return{node:'Lit',val:t.val,line:t.line};}
    if(t.type===TT.STR){this.eat();return{node:'Lit',val:t.val,line:t.line};}
    if(t.type===TT.BOOL){this.eat();return{node:'Lit',val:t.val,line:t.line};}
    if(t.type===TT.NIL){this.eat();return{node:'Lit',val:null,line:t.line};}
    if(t.type===TT.KW&&t.val==='if')return this.parseIfExpr();
    if(t.type===TT.KW&&t.val==='match')return this.parseMatchExpr();
    if(t.type===TT.KW&&t.val==='fn'){
      this.eat();this.eat(TT.LPAREN);const params=[];
      while(!this.check(TT.RPAREN)){const p=this.eat(TT.IDENT);let pType=null;if(this.match([TT.COLON]))pType=this.eat(TT.IDENT).val;params.push({name:p.val,type:pType});if(!this.check(TT.RPAREN))this.eat(TT.COMMA);}
      this.eat(TT.RPAREN);return{node:'Lambda',params,body:this.check(TT.LBRACE)?this.parseBlock():this.parseExpr(),line:t.line};
    }
    if(t.type===TT.IDENT||t.type===TT.KW){if(BUILTINS.has(t.val)){this.eat();return{node:'Ident',name:t.val,line:t.line,builtin:true};}this.eat();return{node:'Ident',name:t.val,line:t.line};}
    if(t.type===TT.LPAREN){this.eat();const e=this.parseExpr();this.eat(TT.RPAREN);return e;}
    if(t.type===TT.LBRACKET){const op=this.eat();const items=[];while(!this.check(TT.RBRACKET)){items.push(this.parseExpr());if(!this.check(TT.RBRACKET))this.eat(TT.COMMA);}this.eat(TT.RBRACKET);return{node:'List',items,line:op.line};}
    if(t.type===TT.LBRACE){const b=this.parseBlock();return b;}
    throw new ParseError(`Unexpected token '${t.val||t.type}'`,t);
  }
}

// ── INTERPRETER ─────────────────────────────────────────
class VeldError extends Error { constructor(m,l,h){super(m);this.line=l||null;this.hint=h||null;} }
class ReturnSignal { constructor(v){this.val=v;} }
class BreakSignal {}
class ContinueSignal {}

class Env {
  constructor(parent=null){this.vars=new Map();this.consts=new Set();this.parent=parent;}
  set(name,val,kind='let'){if(this.consts.has(name))throw new VeldError(`Cannot reassign constant '${name}'`,null,`Use 'let' for mutable variables.`);this.vars.set(name,val);if(kind==='const')this.consts.add(name);}
  get(name){if(this.vars.has(name))return this.vars.get(name);if(this.parent)return this.parent.get(name);throw new VeldError(`Variable '${name}' is not defined`,null,`Declare it with 'let' or 'const'.`);}
  assign(name,val){if(this.consts.has(name))throw new VeldError(`Cannot reassign constant '${name}'`,null,`Declare with 'let' to reassign.`);if(this.vars.has(name)){this.vars.set(name,val);return;}if(this.parent){this.parent.assign(name,val);return;}throw new VeldError(`Cannot assign to undeclared variable '${name}'`,null,`Declare: let ${name} = ...`);}
  child(){return new Env(this);}
}

const _STRUCT_OP_NAMES = {'+':`__add__`,'-':'__sub__','*':'__mul__','/':'__div__','%':'__mod__','**':'__pow__','==':'__eq__','!=':'__ne__','<':'__lt__','>':'__gt__','<=':'__le__','>=':'__ge__'};

class Interpreter {
  /**
   * @param {function(string): void} outputFn - receives printed text
   * @param {Map|object} ffi - FFI function registry
   * @param {object} options
   * @param {function(function): void} [options.scheduleFrame] - defaults to requestAnimationFrame
   * @param {function(function): void} [options.onLoopStart]   - called with stop() when loop frame starts
   * @param {function(): void}         [options.onLoopStop]    - called when loop frame ends
   */
  constructor(outputFn,ffi,options){
    this.output=outputFn;
    this.ffi=(ffi&&typeof ffi.get==='function')?ffi:new Map(Object.entries(ffi||{}));
    this.structOps=new Map();
    this.options=options||{};
  }
  run(ast){const env=new Env();this.execBlock(ast.body,env);}
  execBlock(stmts,env){for(const s of stmts){const r=this.exec(s,env);if(r instanceof ReturnSignal||r instanceof BreakSignal||r instanceof ContinueSignal)return r;}}
  evalBlockAsExpr(stmts,env){for(let i=0;i<stmts.length-1;i++){const r=this.exec(stmts[i],env);if(r instanceof ReturnSignal)return r.val;if(r instanceof BreakSignal||r instanceof ContinueSignal)return null;}if(stmts.length===0)return null;const last=stmts[stmts.length-1];if(last.node==='ExprStmt')return this.eval(last.expr,env);const r=this.exec(last,env);if(r instanceof ReturnSignal)return r.val;return null;}
  evalBlockValue(blockNode,env){return this.evalBlockAsExpr(blockNode.body||[],env.child());}
  exec(node,env){
    switch(node.node){
      case 'VarDecl':{const v=this.eval(node.val,env);env.set(node.name,v,node.kind);return;}
      case 'FnDecl':env.set(node.name,{type:'fn',name:node.name,params:node.params,body:node.body,closure:env},'let');return;
      case 'Return':{const v=node.val?this.eval(node.val,env):null;return new ReturnSignal(v);}
      case 'If':{const c=this.eval(node.cond,env);if(typeof c!=='boolean')throw new VeldError(`if condition must be Bool, got ${this.typeOf(c)}`,node.cond.line);if(c)return this.execBlock(node.then.body,env.child());else if(node.else){if(node.else.node==='If')return this.exec(node.else,env);return this.execBlock(node.else.body,env.child());}return;}
      case 'While':{let itr=0;while(true){const c=this.eval(node.cond,env);if(typeof c!=='boolean')throw new VeldError(`while condition must be Bool`,node.cond.line);if(!c)break;if(++itr>100000)throw new VeldError(`Infinite loop: exceeded 100,000 iterations`,node.line);const r=this.execBlock(node.body.body,env.child());if(r instanceof BreakSignal)break;if(r instanceof ReturnSignal)return r;}return;}
      case 'For':{const src=this.eval(node.src,env);let items;if(Array.isArray(src))items=src;else if(src&&src.type==='range'){items=[];for(let x=src.start;x<src.end;x++)items.push(x);}else if(typeof src==='string')items=[...src];else throw new VeldError(`Cannot iterate over ${this.typeOf(src)}`,node.line);for(const item of items){const inner=env.child();inner.set(node.iter,item,'let');const r=this.execBlock(node.body.body,inner);if(r instanceof BreakSignal)break;if(r instanceof ReturnSignal)return r;}return;}
      case 'Match':{const val=this.eval(node.val,env);for(const arm of node.arms){if(arm.pat.node==='WildPat'){if(arm.body.node==='Block'){return this.execBlock(arm.body.body,env.child());}this.eval(arm.body,env);return;}if(arm.pat.node==='StructPat'){if(!val||val._struct!==arm.pat.structName)continue;const ae=env.child();for(const{field,alias}of arm.pat.bindings){if(!Object.prototype.hasOwnProperty.call(val,field))throw new VeldError(`Struct '${val._struct}' has no field '${field}'`,node.line);ae.set(alias,val[field],'let');}if(arm.body.node==='Block')return this.execBlock(arm.body.body,ae);this.eval(arm.body,ae);return;}const pv=this.eval(arm.pat.val,env);if(this.eq(val,pv)){if(arm.body.node==='Block')return this.execBlock(arm.body.body,env.child());this.eval(arm.body,env);return;}}throw new VeldError(`Non-exhaustive match`,node.line,`Add a wildcard arm: _ -> { ... }`);}
      case 'Print':{const vals=node.args.map(a=>this.eval(a,env));this.output(vals.map(v=>this.str(v)).join('')+(node.newline?'\n':''));return;}
      case 'ExprStmt':this.eval(node.expr,env);return;
      case 'TypeAlias':return;
      case 'DestructureDecl':{const val=this.eval(node.val,env);if(node.kind==='struct'){if(!val||!val._struct)throw new VeldError(`Cannot destructure non-struct value`,node.line);for(const{field,alias}of node.names){if(!Object.prototype.hasOwnProperty.call(val,field))throw new VeldError(`Struct '${val._struct}' has no field '${field}'`,node.line);env.set(alias,val[field],node.kind2||'let');};}else{if(!Array.isArray(val))throw new VeldError(`Cannot list-destructure non-List value`,node.line);node.names.forEach((name,i)=>{if(i>=val.length)throw new VeldError(`Not enough elements to destructure`,node.line);env.set(name,val[i],node.kind2||'let');});if(node.rest)env.set(node.rest,val.slice(node.names.length),node.kind2||'let');}return;}
      case 'ImplDecl':{if(!this.structOps.has(node.structName))this.structOps.set(node.structName,{});const ops=this.structOps.get(node.structName);for(const m of node.methods)ops[m.name]={type:'fn',name:m.name,params:m.params,body:m.body,closure:env};return;}
      case 'ModuleDecl':{const menv=env.child();this.execBlock(node.body.body,menv);const mod={_module:true,_name:node.name};for(const[k,v]of menv.vars)mod[k]=v;env.set(node.name,mod,'const');return;}
      case 'UseDecl':{let mod;try{mod=env.get(node.name);}catch(_){throw new VeldError(`Module '${node.name}' is not defined`,node.line);}if(!mod||!mod._module)throw new VeldError(`'${node.name}' is not a module`,node.line);for(const k of Object.keys(mod)){if(!k.startsWith('_'))env.set(k,mod[k],'let');}return;}
      case 'StructDecl':{const sname=node.name;const fields=node.fields;const ctor={type:'fn',name:sname,params:fields.map(f=>({name:f.name,type:f.type})),body:null,closure:null,_native:(...args)=>{if(args.length!==fields.length)throw new VeldError(`${sname}() expects ${fields.length} field(s), got ${args.length}`,node.line);const inst={_struct:sname,_fields:fields.map(f=>f.name)};fields.forEach((f,i)=>{inst[f.name]=args[i];});return inst;}};env.set(sname,ctor,'const');return;}
      case 'Break':return new BreakSignal();
      case 'Continue':return new ContinueSignal();
      case 'Block':return this.execBlock(node.body,env.child());
      case 'LoopFrame':{
        const interp=this;
        const loopBody=node.body.body;
        let stopped=false;
        const stop=()=>{stopped=true;if(interp.options.onLoopStop)interp.options.onLoopStop();};
        if(this.options.onLoopStart)this.options.onLoopStart(stop);
        const sched=this.options.scheduleFrame||requestAnimationFrame;
        function step(){if(stopped)return;try{const r=interp.execBlock(loopBody,env);if(r instanceof BreakSignal||r instanceof ReturnSignal){stop();return;}sched(step);}catch(e){stop();throw e;}}
        sched(step);return;}
      case 'ExportModule':{const mod=env.get(node.name);if(!mod||!mod._module)throw new VeldError(`'${node.name}' is not a module`,node.line);try{localStorage.setItem('veld-module-'+node.name,JSON.stringify(mod));}catch(e){}return;}
      case 'ImportModule':{try{const raw=localStorage.getItem('veld-module-'+node.name);if(!raw)throw new VeldError(`No exported module '${node.name}' found`,node.line);const mod=JSON.parse(raw);try{env.set(node.name,mod,'const');}catch(_){}}catch(e){if(e instanceof VeldError)throw e;throw new VeldError(`Failed to import module '${node.name}'`,node.line);}return;}
      default:throw new VeldError(`Unknown statement node: ${node.node}`);
    }
  }
  eval(node,env){
    switch(node.node){
      case 'Lit':return node.val;
      case 'Ident':return env.get(node.name);
      case 'List':return node.items.map(i=>this.eval(i,env));
      case 'Range':{const s=this.eval(node.start,env),e=this.eval(node.end,env);if(typeof s!=='number'||typeof e!=='number')throw new VeldError(`Range requires Int operands`,node.line);return{type:'range',start:s,end:e};}
      case 'Assign':{const v=this.eval(node.val,env);env.assign(node.name,v);return v;}
      case 'UnaryOp':{const v=this.eval(node.val,env);if(node.op==='-'){if(typeof v!=='number')throw new VeldError(`Unary '-' requires a number`,node.line);return -v;}if(node.op==='!'||node.op==='not'){if(typeof v!=='boolean')throw new VeldError(`'not' requires Bool`,node.line);return !v;}throw new VeldError(`Unknown unary op: ${node.op}`,node.line);}
      case 'BinOp':return this.evalBinOp(node,env);
      case 'Call':return this.evalCall(node,env);
      case 'IfExpr':{const c=this.eval(node.cond,env);if(typeof c!=='boolean')throw new VeldError(`if condition must be Bool, got ${this.typeOf(c)}`,node.cond.line);if(c)return this.evalBlockValue(node.then,env);if(node.else.node==='IfExpr')return this.eval(node.else,env);return this.evalBlockValue(node.else,env);}
      case 'Match':{
        const val=this.eval(node.val,env);
        for(const arm of node.arms){
          if(arm.pat.node==='WildPat'){if(arm.body.node==='Block')return this.evalBlockAsExpr(arm.body.body,env.child());return this.eval(arm.body,env);}
          if(arm.pat.node==='StructPat'){if(!val||val._struct!==arm.pat.structName)continue;const ae=env.child();for(const{field,alias}of arm.pat.bindings)ae.set(alias,val[field],'let');if(arm.body.node==='Block')return this.evalBlockAsExpr(arm.body.body,ae);return this.eval(arm.body,ae);}
          const pv=this.eval(arm.pat.val,env);if(this.eq(val,pv)){if(arm.body.node==='Block')return this.evalBlockAsExpr(arm.body.body,env.child());return this.eval(arm.body,env);}
        }
        throw new VeldError(`Non-exhaustive match`,node.line,`Add a wildcard arm: _ -> { ... }`);
      }
      case 'Index':{const t=this.eval(node.target,env);const i=this.eval(node.idx,env);if(Array.isArray(t)){if(typeof i!=='number')throw new VeldError(`List index must be Int`,node.line);const ii=i<0?t.length+i:i;if(ii<0||ii>=t.length)throw new VeldError(`Index ${i} out of bounds`,node.line);return t[ii];}if(typeof t==='string'){if(typeof i!=='number')throw new VeldError(`String index must be Int`,node.line);const ii=i<0?t.length+i:i;if(ii<0||ii>=t.length)throw new VeldError(`Index ${i} out of bounds`,node.line);return t[ii];}throw new VeldError(`Cannot index into ${this.typeOf(t)}`,node.line);}
      case 'Dot':{
        const t=this.eval(node.target,env);
        if(t&&typeof t==='object'&&t._module){if(Object.prototype.hasOwnProperty.call(t,node.prop))return t[node.prop];throw new VeldError(`Module '${t._name}' has no export '${node.prop}'`,node.line);}
        if(t&&typeof t==='object'&&t._struct){if(node.prop==='type')return t._struct;if(node.prop==='fields')return t._fields?[...t._fields]:[];if(Object.prototype.hasOwnProperty.call(t,node.prop))return t[node.prop];throw new VeldError(`Struct '${t._struct}' has no field '${node.prop}'`,node.line,`Available: ${(t._fields||[]).join(', ')}`);}
        const makeFn=(name,nativeArgs,impl)=>({type:'fn',name,params:nativeArgs.map(n=>({name:n,type:null})),body:null,closure:null,_native:impl});
        if(typeof t==='string'){const m={length:t.length,upper:makeFn('upper',[],()=>t.toUpperCase()),lower:makeFn('lower',[],()=>t.toLowerCase()),trim:makeFn('trim',[],()=>t.trim()),reverse:makeFn('reverse',[],()=>[...t].reverse().join(''))};if(node.prop in m)return m[node.prop];throw new VeldError(`Str has no property '${node.prop}'`,node.line);}
        if(Array.isArray(t)){const m={length:t.length,first:t.length>0?t[0]:null,last:t.length>0?t[t.length-1]:null,reverse:makeFn('reverse',[],()=>[...t].reverse())};if(node.prop in m)return m[node.prop];throw new VeldError(`List has no property '${node.prop}'`,node.line);}
        if(t&&typeof t==='object'&&!t.type&&!t._struct&&!t._module){if(Object.prototype.hasOwnProperty.call(t,node.prop))return t[node.prop];throw new VeldError(`Object has no property '${node.prop}'`,node.line);}
        throw new VeldError(`'${this.typeOf(t)}' has no property '${node.prop}'`,node.line);
      }
      case 'Block':return this.evalBlockValue(node,env);
      case 'Lambda':return{type:'fn',name:'<lambda>',params:node.params,body:node.body,closure:env};
      case 'Await':{const v=this.eval(node.val,env);if(v&&v._pendingPromise)return v;return v;}
      default:throw new VeldError(`Unknown expression node: ${node.node}`);
    }
  }
  evalBinOp(node,env){
    if(node.op==='and'){const l=this.eval(node.left,env);if(typeof l!=='boolean')throw new VeldError(`'and' requires Bool, got ${this.typeOf(l)}`,node.left.line);if(!l)return false;const r=this.eval(node.right,env);if(typeof r!=='boolean')throw new VeldError(`'and' requires Bool, got ${this.typeOf(r)}`,node.right.line);return r;}
    if(node.op==='or'){const l=this.eval(node.left,env);if(typeof l!=='boolean')throw new VeldError(`'or' requires Bool, got ${this.typeOf(l)}`,node.left.line);if(l)return true;const r=this.eval(node.right,env);if(typeof r!=='boolean')throw new VeldError(`'or' requires Bool, got ${this.typeOf(r)}`,node.right.line);return r;}
    const l=this.eval(node.left,env),r=this.eval(node.right,env);
    if(l&&typeof l==='object'&&l._struct){const opName=_STRUCT_OP_NAMES[node.op];if(opName){const ops=this.structOps.get(l._struct);const method=ops&&ops[opName];if(method){const fenv=method.closure.child();fenv.set(method.params[0].name,l,'let');if(method.params[1])fenv.set(method.params[1].name,r,'let');const res=this.execBlock(method.body.body,fenv);if(res instanceof ReturnSignal)return res.val;return res!==undefined?res:null;}}}
    switch(node.op){
      case '+':if(typeof l==='number'&&typeof r==='number')return l+r;if(typeof l==='string'||typeof r==='string')return this.str(l)+this.str(r);if(Array.isArray(l)&&Array.isArray(r))return[...l,...r];throw new VeldError(`Cannot add ${this.typeOf(l)} and ${this.typeOf(r)}`,node.line);
      case '-':return this.numOp(l,r,'-',node.line,(a,b)=>a-b);
      case '*':if(typeof l==='number'&&typeof r==='number')return l*r;if(typeof l==='string'&&typeof r==='number'&&Number.isInteger(r))return l.repeat(Math.max(0,r));throw new VeldError(`Cannot multiply ${this.typeOf(l)} by ${this.typeOf(r)}`,node.line);
      case '/':if(typeof l!=='number'||typeof r!=='number')throw new VeldError(`'/' requires numbers`,node.line);if(r===0)throw new VeldError(`Division by zero`,node.line);return l/r;
      case '//':if(typeof l!=='number'||typeof r!=='number')throw new VeldError(`'//' requires numbers`,node.line);if(r===0)throw new VeldError(`Integer division by zero`,node.line);return Math.trunc(l/r);
      case '%':return this.numOp(l,r,'%',node.line,(a,b)=>a%b);
      case '**':return this.numOp(l,r,'**',node.line,(a,b)=>a**b);
      case '==':return this.eq(l,r);
      case '!=':return !this.eq(l,r);
      case '<':return this.cmp(l,r,'<',node.line);
      case '>':return this.cmp(l,r,'>',node.line);
      case '<=':return this.cmp(l,r,'<=',node.line);
      case '>=':return this.cmp(l,r,'>=',node.line);
      default:throw new VeldError(`Unknown operator: ${node.op}`,node.line);
    }
  }
  evalCall(node,env){
    if(node.callee.node==='Ident'&&BUILTINS.has(node.callee.name))return this.callBuiltin(node.callee.name,node.args.map(a=>this.eval(a,env)),node.line);
    if(node.callee.node==='Ident'&&this.ffi.has(node.callee.name)){try{return this.ffi.get(node.callee.name)(...node.args.map(a=>this.eval(a,env)));}catch(e){throw new VeldError(`FFI error in '${node.callee.name}': ${e.message}`,node.line);}}
    let fn=this.eval(node.callee,env);
    if(!fn||fn.type!=='fn')throw new VeldError(`'${node.callee.name||'value'}' is not a function`,node.line);
    if(fn._native){return fn._native(...node.args.map(a=>this.eval(a,env)));}
    let callNode=node,callEnv=env,depth=0;
    while(true){
      if(!fn||fn.type!=='fn')throw new VeldError(`Value is not a function`,callNode.line);
      if(fn._native)return fn._native(...callNode.args.map(a=>this.eval(a,callEnv)));
      if(fn.params.length!==callNode.args.length)throw new VeldError(`Function '${fn.name}' expects ${fn.params.length} arg(s), got ${callNode.args.length}`,callNode.line);
      const argVals=callNode.args.map(a=>this.eval(a,callEnv));
      const fenv=fn.closure.child();
      fn.params.forEach((p,i)=>fenv.set(p.name,argVals[i],'let'));
      if(fn.body.node!=='Block')return this.eval(fn.body,fenv);
      const stmts=fn.body.body;
      for(let i=0;i<stmts.length-1;i++){const r=this.exec(stmts[i],fenv);if(r instanceof ReturnSignal)return r.val;if(r instanceof BreakSignal||r instanceof ContinueSignal)return null;}
      if(stmts.length===0)return null;
      const last=stmts[stmts.length-1];
      if(last.node==='Return'&&last.val&&last.val.node==='Call'){const nextFn=this.eval(last.val.callee,fenv);if(nextFn&&nextFn.type==='fn'&&!nextFn._native){fn=nextFn;callNode=last.val;callEnv=fenv;if(++depth>1000000)throw new VeldError(`Infinite tail recursion`,last.line);continue;}}
      const r=this.exec(last,fenv);if(r instanceof ReturnSignal)return r.val;return null;
    }
  }
  callBuiltin(name,args,line){
    const chk=(c,m,h)=>{if(!c)throw new VeldError(m,line,h);};
    switch(name){
      case 'len':chk(args.length===1,`len() takes 1 argument`);if(typeof args[0]==='string')return args[0].length;if(Array.isArray(args[0]))return args[0].length;throw new VeldError(`len() works on Str and List`,line);
      case 'range':if(args.length===1)return{type:'range',start:0,end:args[0]};if(args.length===2)return{type:'range',start:args[0],end:args[1]};throw new VeldError(`range() takes 1 or 2 arguments`,line);
      case 'push':chk(args.length===2&&Array.isArray(args[0]),`push(list, item)`);args[0].push(args[1]);return args[0];
      case 'pop':chk(args.length===1&&Array.isArray(args[0]),`pop(list)`);if(args[0].length===0)throw new VeldError(`Cannot pop from empty list`,line);return args[0].pop();
      case 'join':chk(args.length===2&&Array.isArray(args[0])&&typeof args[1]==='string',`join(list, sep)`);return args[0].map(v=>this.str(v)).join(args[1]);
      case 'split':chk(args.length===2&&typeof args[0]==='string'&&typeof args[1]==='string',`split(str, sep)`);return args[0].split(args[1]);
      case 'to_int':chk(args.length===1,`to_int() takes 1 argument`);if(typeof args[0]==='number')return Math.trunc(args[0]);if(typeof args[0]==='boolean')return args[0]?1:0;if(typeof args[0]==='string'){const n=parseInt(args[0],10);if(isNaN(n))throw new VeldError(`Cannot convert "${args[0]}" to Int`,line);return n;}throw new VeldError(`Cannot convert ${this.typeOf(args[0])} to Int`,line);
      case 'to_float':chk(args.length===1,`to_float() takes 1 argument`);{const n=parseFloat(args[0]);if(isNaN(n))throw new VeldError(`Cannot convert to Float`,line);return n;}
      case 'to_str':chk(args.length===1,`to_str() takes 1 argument`);return this.str(args[0]);
      case 'to_bool':chk(args.length===1,`to_bool() takes 1 argument`);return Boolean(args[0]);
      case 'floor':chk(args.length===1&&typeof args[0]==='number',`floor() takes a number`);return Math.floor(args[0]);
      case 'ceil':chk(args.length===1&&typeof args[0]==='number',`ceil() takes a number`);return Math.ceil(args[0]);
      case 'abs':chk(args.length===1&&typeof args[0]==='number',`abs() takes a number`);return Math.abs(args[0]);
      case 'min':chk(args.length===2&&typeof args[0]==='number'&&typeof args[1]==='number',`min() takes 2 numbers`);return Math.min(args[0],args[1]);
      case 'max':chk(args.length===2&&typeof args[0]==='number'&&typeof args[1]==='number',`max() takes 2 numbers`);return Math.max(args[0],args[1]);
      case 'sqrt':chk(args.length===1&&typeof args[0]==='number'&&args[0]>=0,`sqrt() takes a non-negative number`);return Math.sqrt(args[0]);
      case 'type_of':chk(args.length===1,`type_of() takes 1 argument`);return this.typeOf(args[0]);
      default:throw new VeldError(`Unknown builtin '${name}'`,line);
    }
  }
  numOp(l,r,op,line,fn){if(typeof l!=='number'||typeof r!=='number')throw new VeldError(`Operator '${op}' requires numbers, got ${this.typeOf(l)} and ${this.typeOf(r)}`,line);return fn(l,r);}
  cmp(l,r,op,line){if(typeof l!==typeof r)throw new VeldError(`Cannot compare ${this.typeOf(l)} with ${this.typeOf(r)}`,line);return{'>':l>r,'<':l<r,'>=':l>=r,'<=':l<=r}[op];}
  eq(a,b){if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>this.eq(v,b[i]));return a===b;}
  typeOf(v){if(v===null)return'Nil';if(typeof v==='boolean')return'Bool';if(typeof v==='number')return Number.isInteger(v)?'Int':'Float';if(typeof v==='string')return'Str';if(Array.isArray(v))return'List';if(v&&v.type==='fn')return'Fn';if(v&&v.type==='range')return'Range';if(v&&typeof v==='object'&&v._struct)return v._struct;return'Any';}
  str(v){if(v===null)return'nil';if(typeof v==='boolean')return v?'true':'false';if(Array.isArray(v))return'['+v.map(x=>this.str(x)).join(', ')+']';if(v&&v.type==='range')return`${v.start}..${v.end}`;if(v&&v.type==='fn')return`<fn ${v.name}>`;if(v&&typeof v==='object'&&v._struct){const ops=this.structOps.get(v._struct);const sm=ops&&ops['__str__'];if(sm){const fenv=sm.closure.child();fenv.set(sm.params[0].name,v,'let');const res=this.execBlock(sm.body.body,fenv);const raw=res instanceof ReturnSignal?res.val:null;return raw!==null&&raw!==undefined?String(raw):'';}const fields=(v._fields||[]).map(f=>`${f}: ${this.str(v[f])}`).join(', ');return`${v._struct} { ${fields} }`;}if(v&&typeof v==='object'&&v._module)return`<module ${v._name}>`;return String(v);}
  repr(v){return typeof v==='string'?`"${v}"`:this.str(v);}
}

// ── STATIC LINT ─────────────────────────────────────────
function lint(src){
  const issues=[],lines=src.split('\n');
  let depth=0;
  for(let i=0;i<lines.length;i++){const line=lines[i];let inStr=false,strChar='';for(let j=0;j<line.length;j++){const ch=line[j];if(!inStr&&ch==='#')break;if(!inStr&&(ch==='"'||ch==="'")){inStr=true;strChar=ch;continue;}if(inStr&&ch==='\\'){j++;continue;}if(inStr&&ch===strChar){inStr=false;continue;}if(!inStr){if(ch==='{')depth++;if(ch==='}'){depth--;if(depth<0){issues.push({type:'error',line:i+1,msg:'Unexpected closing brace }',hint:'Check that every } matches an opening {'});depth=0;}}}}}
  if(depth>0)issues.push({type:'warning',line:lines.length,msg:`Unclosed block: ${depth} opening brace(s) not closed`,hint:'Add } to close the block'});
  for(let i=0;i<lines.length;i++){if(lines[i].length>120)issues.push({type:'info',line:i+1,msg:'Line exceeds 120 characters'});}
  return issues;
}

// ── STATIC TYPE CHECKER ─────────────────────────────────
function typeCheck(ast){
  const warnings=[];
  const typeEnv=new Map();
  function inferType(node){
    if(!node)return'Any';
    if(node.node==='Lit'){if(typeof node.val==='number')return Number.isInteger(node.val)?'Int':'Float';if(typeof node.val==='string')return'Str';if(typeof node.val==='boolean')return'Bool';if(node.val===null)return'Nil';return'Any';}
    if(node.node==='Ident'){return typeEnv.get(node.name)||'Any';}
    if(node.node==='List')return'List';
    if(node.node==='Range')return'Range';
    if(node.node==='BinOp'){const l=inferType(node.left),r=inferType(node.right);if(['+','-','*','/','//','%','**'].includes(node.op)){if(l==='Float'||r==='Float')return'Float';if(l==='Int'&&r==='Int')return'Int';if(node.op==='+'&&(l==='Str'||r==='Str'))return'Str';return'Any';}if(['==','!=','<','>','<=','>=','and','or'].includes(node.op))return'Bool';return'Any';}
    if(node.node==='UnaryOp'){if(node.op==='-')return inferType(node.val);if(node.op==='!'||node.op==='not')return'Bool';return'Any';}
    if(node.node==='Call')return'Any';
    if(node.node==='IfExpr'){const t1=inferTypeFromBlock(node.then);const t2=node.else.node==='IfExpr'?inferType(node.else):inferTypeFromBlock(node.else);if(t1!=='Any'&&t2!=='Any'&&t1!==t2)warnings.push({type:'warning',line:node.line,msg:`if-expression branches return different types: ${t1} vs ${t2}`,hint:`Both branches should return the same type`});return(t1===t2)?t1:'Any';}
    return'Any';
  }
  function inferTypeFromBlock(block){if(!block||!block.body||block.body.length===0)return'Nil';const last=block.body[block.body.length-1];if(last.node==='ExprStmt')return inferType(last.expr);return'Nil';}
  function compatible(declared,actual){if(declared==='Any'||actual==='Any')return true;if(declared===actual)return true;if(declared==='Float'&&actual==='Int')return true;return false;}
  function checkStmt(node){
    if(!node)return;
    if(node.node==='VarDecl'){const actual=inferType(node.val);if(node.typeAnn){typeEnv.set(node.name,node.typeAnn);if(!compatible(node.typeAnn,actual)&&actual!=='Any'){warnings.push({type:'warning',line:node.line,msg:`Type mismatch: '${node.name}' declared as ${node.typeAnn} but assigned ${actual}`,hint:`Expected ${node.typeAnn}, got ${actual}`});}}else{typeEnv.set(node.name,actual);}}
    if(node.node==='FnDecl'){typeEnv.set(node.name,'Fn');if(node.retType&&node.body&&node.body.body){const stmts=node.body.body;for(const s of stmts){if(s.node==='Return'&&s.val){const rt=inferType(s.val);if(!compatible(node.retType,rt)&&rt!=='Any'){warnings.push({type:'warning',line:s.line||node.line,msg:`Return type mismatch in '${node.name}': declared ${node.retType}, returning ${rt}`});}}}}}
    if(node.node==='If'){const ct=inferType(node.cond);if(ct!=='Bool'&&ct!=='Any'){warnings.push({type:'warning',line:node.cond.line||node.line,msg:`Condition should be Bool, got ${ct}`,hint:'Use a comparison or boolean expression'});}}
    if(node.node==='While'){const ct=inferType(node.cond);if(ct!=='Bool'&&ct!=='Any'){warnings.push({type:'warning',line:node.cond.line||node.line,msg:`While condition should be Bool, got ${ct}`});}}
    if(node.node==='Program'||node.node==='Block'){if(node.body)node.body.forEach(checkStmt);}
    if(node.then)checkStmt(node.then);
    if(node.else)checkStmt(node.else);
    if(node.body&&node.body.node==='Block')node.body.body.forEach(checkStmt);
  }
  checkStmt(ast);
  return warnings;
}

return { TT, KEYWORDS, BUILTINS, LexError, ParseError, VeldError,
         ReturnSignal, BreakSignal, ContinueSignal,
         Env, tokenize, Parser, Interpreter, lint, typeCheck };

})); // end UMD
