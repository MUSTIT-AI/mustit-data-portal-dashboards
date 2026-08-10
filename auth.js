// auth.js — MUST IT 대시보드 공통 로그인 게이트 (Supabase Auth · 이메일+비밀번호)
// 사용법: 페이지 <head>에
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="auth.js"></script>   (dashboards/ 안에서는 "../auth.js")
// 그리고 페이지 코드에서 window.MUSTIT.ready(function(){ ... MUSTIT.rpc("dash_summary",{p}) ... })
(function(){
  var SB  = "https://hhvmhtejmhhxksnldfmi.supabase.co";
  var KEY = "sb_publishable_3qHI5hEv90wiU03q3mmS4Q_nUdAovOw";

  if(!window.supabase || !window.supabase.createClient){
    document.addEventListener("DOMContentLoaded", function(){
      document.body.innerHTML = '<p style="font-family:system-ui;padding:40px;color:#c8102e">로그인 모듈을 불러오지 못했습니다. 네트워크(supabase CDN)를 확인하세요.</p>';
    });
    return;
  }

  var client = window.supabase.createClient(SB, KEY, {
    auth:{ persistSession:true, autoRefreshToken:true, storageKey:"mustit-dash-auth" }
  });
  var session = null;
  var readyCbs = [];
  var started = false;

  // 매 호출마다 최신 세션 토큰 확보(자동 갱신 반영). 오래 열어둔 탭의 만료 토큰 → "인증 실패" 방지.
  function freshToken(){
    return client.auth.getSession().then(function(res){
      var s = (res && res.data) ? res.data.session : null;
      if(s) session = s;
      return s ? s.access_token : null;
    }).catch(function(){ return session ? session.access_token : null; });
  }
  function callJson(url, body){
    return freshToken().then(function(tok){
      return fetch(url, { method:"POST", headers:{ apikey:KEY, Authorization:"Bearer "+(tok||KEY), "Content-Type":"application/json" }, body: JSON.stringify(body||{}) });
    });
  }

  window.MUSTIT = {
    client: client,
    user: function(){ return session ? session.user : null; },
    ready: function(cb){ readyCbs.push(cb); if(session) try{cb(session);}catch(e){console.error(e);} },
    signOut: function(){ client.auth.signOut().then(function(){ location.reload(); }); },
    // 인증 토큰으로 RPC 호출 (로그인 안 됐으면 거부됨)
    rpc: function(fn, body){
      return callJson(SB+"/rest/v1/rpc/"+fn, body).then(function(r){ return r.text().then(function(t){
        if(!r.ok) throw new Error(fn+" "+r.status+": "+t);
        return t ? JSON.parse(t) : null;
      });});
    },
    // Edge Function 호출 (계정 관리 등 서버측 관리자 기능)
    fn: function(name, body){
      return callJson(SB+"/functions/v1/"+name, body).then(function(r){ return r.text().then(function(t){
        var d = t ? JSON.parse(t) : null;
        if(!r.ok) throw new Error((d && d.error) || ("HTTP "+r.status));
        return d;
      });});
    }
  };

  // ---- 로그인 오버레이 ----
  var OV_ID = "mustit-login-overlay";
  function ensureStyle(){
    if(document.getElementById("mustit-auth-style")) return;
    var s=document.createElement("style"); s.id="mustit-auth-style";
    s.textContent =
      '#'+OV_ID+'{position:fixed;inset:0;z-index:99999;background:#f4f4f5;display:flex;align-items:center;justify-content:center;font-family:"Pretendard","Malgun Gothic",system-ui,sans-serif}'+
      '#'+OV_ID+' .box{background:#fff;padding:30px 28px;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.1);width:320px}'+
      '#'+OV_ID+' h2{margin:0 0 4px;font-size:19px}'+
      '#'+OV_ID+' p.d{margin:0 0 16px;color:#6b6a66;font-size:12.5px}'+
      '#'+OV_ID+' input{width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box;margin-bottom:9px}'+
      '#'+OV_ID+' button{width:100%;padding:11px;border:0;border-radius:8px;background:#c8102e;color:#fff;font-weight:700;font-size:15px;cursor:pointer}'+
      '#'+OV_ID+' button:disabled{background:#d9a6ad;cursor:default}'+
      '#'+OV_ID+' .msg{color:#c8102e;font-size:12.5px;min-height:16px;margin-top:9px}'+
      '#'+OV_ID+' .signup{margin:16px 0 0;padding-top:14px;border-top:1px solid #eee;text-align:center;font-size:12.5px;color:#6b6a66;line-height:1.6}'+
      '#'+OV_ID+' .signup a{color:#c8102e;font-weight:700;text-decoration:none}'+
      '#'+OV_ID+' .signup a:hover{text-decoration:underline}'+
      '#mustit-userbar{position:fixed;right:10px;bottom:10px;z-index:9999;background:rgba(28,27,25,.86);color:#fff;font-family:system-ui,sans-serif;'+
      'font-size:11.5px;padding:6px 10px;border-radius:20px;display:flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(0,0,0,.2)}'+
      '#mustit-userbar button{background:transparent;border:1px solid rgba(255,255,255,.5);color:#fff;border-radius:12px;padding:2px 9px;font-size:11px;cursor:pointer}';
    document.head.appendChild(s);
  }
  function showLogin(){
    ensureStyle();
    if(document.getElementById(OV_ID)) return;
    var ov=document.createElement("div"); ov.id=OV_ID;
    ov.innerHTML =
      '<form class="box">'+
      '<h2>📊 MUST IT 대시보드</h2>'+
      '<p class="d">회사 계정으로 로그인하세요.</p>'+
      '<input id="mustit-email" type="email" placeholder="이메일" autocomplete="username" autofocus>'+
      '<input id="mustit-pw" type="password" placeholder="비밀번호" autocomplete="current-password">'+
      '<button type="submit" id="mustit-login-btn">로그인</button>'+
      '<div class="msg" id="mustit-msg"></div>'+
      '<p class="signup">계정이 없으신가요?<br><a href="https://mustit-orders-portal-production.up.railway.app/#devdash" target="_blank" rel="noopener">데이터 포털에서 계정 등록 요청 →</a></p>'+
      '</form>';
    document.body.appendChild(ov);
    var form=ov.querySelector("form");
    form.addEventListener("submit", function(e){
      e.preventDefault();
      var email=document.getElementById("mustit-email").value.trim();
      var pw=document.getElementById("mustit-pw").value;
      var btn=document.getElementById("mustit-login-btn"); var msg=document.getElementById("mustit-msg");
      if(!email||!pw){ msg.textContent="이메일과 비밀번호를 입력하세요."; return; }
      btn.disabled=true; btn.textContent="로그인 중…"; msg.textContent="";
      client.auth.signInWithPassword({email:email, password:pw}).then(function(res){
        if(res.error){ msg.textContent="로그인 실패: 이메일 또는 비밀번호를 확인하세요."; btn.disabled=false; btn.textContent="로그인"; return; }
        location.reload();
      });
    });
  }
  function hideLogin(){ var ov=document.getElementById(OV_ID); if(ov) ov.remove(); }
  function showUserBar(){
    ensureStyle();
    if(document.getElementById("mustit-userbar")) return;
    var bar=document.createElement("div"); bar.id="mustit-userbar";
    bar.innerHTML='<span>'+(session.user.email||"로그인됨")+'</span><button id="mustit-pw">비번변경</button><button id="mustit-logout">로그아웃</button>';
    document.body.appendChild(bar);
    document.getElementById("mustit-logout").onclick=function(){ window.MUSTIT.signOut(); };
    document.getElementById("mustit-pw").onclick=function(){
      var pw=prompt("새 비밀번호(8자 이상)를 입력하세요:"); if(pw===null)return; pw=pw.trim();
      if(pw.length<8){ alert("비밀번호는 8자 이상이어야 합니다"); return; }
      client.auth.updateUser({password:pw}).then(function(res){ alert(res.error ? ("변경 실패: "+res.error.message) : "비밀번호를 변경했습니다."); });
    };
  }

  function runReady(){ readyCbs.forEach(function(cb){ try{cb(session);}catch(e){console.error(e);} }); }

  function boot(){
    if(started) return; started=true;
    client.auth.getSession().then(function(res){
      session = res.data ? res.data.session : null;
      if(session){ hideLogin(); showUserBar(); runReady(); }
      else { showLogin(); }
    });
    client.auth.onAuthStateChange(function(evt, s){
      if(evt==="SIGNED_OUT"){ location.reload(); }
      else if(s){ session = s; }  // 토큰 갱신·로그인 시 세션 최신화
    });
  }
  if(document.body) boot(); else document.addEventListener("DOMContentLoaded", boot);
})();
