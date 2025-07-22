// main.ts - Deno Grok代理服务 (修复版)
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

interface AccountConfig {
  cookies: string;
  userAgent?: string;
}

// 验证 cookies 格式
function validateCookies(cookies: string): string {
  if (!cookies) {
    throw new Error("Cookies are empty or undefined");
  }
  const cleanedCookies = cookies
    .replace(/\n/g, '') // 移除换行符
    .replace(/\r/g, '') // 移除回车符
    .replace(/PORT=8000/g, '') // 移除误包含的环境变量
    .trim(); // 移除首尾空格
  if (!cleanedCookies.match(/^[^;]+(;\s*[^;]+)*$/)) {
    throw new Error("Invalid cookies format");
  }
  if (!cleanedCookies.includes("cf_clearance") || !cleanedCookies.includes("sso=")) {
    throw new Error("Missing required cookies (cf_clearance or sso)");
  }
  return cleanedCookies;
}

// 账号配置 - 仅保留 account1，依赖环境变量
const ACCOUNTS: Record<string, AccountConfig> = {
  account1: {
    cookies: (() => {
      try {
        return validateCookies(Deno.env.get("ACCOUNT1_COOKIES") || "");
      } catch (error) {
        console.error("Invalid cookies for account1:", error.message);
        return "";
      }
    })(),
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0"
  }
};

// CORS头部
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-account-id",
};

// 处理CORS预检请求
function handleCORS(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }
  return null;
}

// 测试账号连接
async function testAccount(accountId: string): Promise<{ success: boolean; message: string; location?: string }> {
  try {
    const account = ACCOUNTS[accountId];
    if (!account || !account.cookies) {
      return { 
        success: false, 
        message: `Account ${accountId} not configured or missing cookies` 
      };
    }

    const testUrl = "https://grok.x.ai/";
    
    const response = await fetch(testUrl, {
      method: "GET",
      headers: {
        "Cookie": account.cookies,
        "User-Agent": account.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Referer": "https://grok.x.ai/",
        "Origin": "https://grok.x.ai",
        "Sec-Ch-Ua": `"Chromium";v="138", "Microsoft Edge";v="138", "Not=A?Brand";v="99"`,
        "Sec-Ch-Ua-Platform": `"Windows"`
      },
      redirect: "follow", // 跟随重定向
    });

    const responseText = await response.text();
    const location = response.headers.get("Location") || "";
    console.log(`Test account ${accountId}: HTTP ${response.status}, Location: ${location}, User-Agent: ${account.userAgent}, Cookies: ${account.cookies.substring(0, 50)}..., Response: ${responseText.substring(0, 100)}...`);

    // 检查是否为 Cloudflare 验证页面
    if (responseText.includes("challenge-form") || responseText.includes("<title>Please wait...</title>")) {
      return {
        success: false,
        message: "Cloudflare verification required, please update cookies manually",
        location
      };
    }

    if (response.status === 200) {
      return { success: true, message: "Connection test successful", location };
    } else if (response.status === 401 || response.status === 403) {
      return { success: false, message: `Authentication failed - cookies may be invalid (HTTP ${response.status})`, location };
    } else {
      return { success: false, message: `HTTP ${response.status}: ${responseText.substring(0, 200)}`, location };
    }
  } catch (error) {
    console.error(`Test account ${accountId} failed:`, error);
    return { 
      success: false, 
      message: `Connection failed: ${error.message}` 
    };
  }
}

// 调试路由，返回详细响应信息
async function debugAccount(accountId: string): Promise<Response> {
  try {
    const account = ACCOUNTS[accountId];
    if (!account || !account.cookies) {
      return new Response(
        JSON.stringify({ error: `Account ${accountId} not configured or missing cookies` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const testUrl = "https://grok.x.ai/";
    const response = await fetch(testUrl, {
      method: "GET",
      headers: {
        "Cookie": account.cookies,
        "User-Agent": account.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Referer": "https://grok.x.ai/",
        "Origin": "https://grok.x.ai",
        "Sec-Ch-Ua": `"Chromium";v="138", "Microsoft Edge";v="138", "Not=A?Brand";v="99"`,
        "Sec-Ch-Ua-Platform": `"Windows"`
      },
      redirect: "follow",
    });

    const responseText = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return new Response(
      JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        headers,
        body: responseText.substring(0, 1000),
        cloudflareVerification: responseText.includes("challenge-form") || responseText.includes("<title>Please wait...</title>")
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "Debug failed", details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// 代理Grok请求
async function proxyGrokRequest(request: Request, accountId: string): Promise<Response> {
  try {
    const account = ACCOUNTS[accountId];
    if (!account || !account.cookies) {
      return new Response(
        JSON.stringify({ error: `Account ${accountId} not configured or missing cookies` }),
        { 
          status: 400, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    const url = new URL(request.url);
    let targetPath = url.searchParams.get("path") || "/";
    
    if (!targetPath.startsWith("/")) {
      targetPath = "/" + targetPath;
    }
    
    const grokUrl = `https://grok.x.ai${targetPath}`;

    console.log(`Proxying request to: ${grokUrl} for account: ${accountId}, User-Agent: ${account.userAgent}`);

    const headers: HeadersInit = {
      "Cookie": account.cookies,
      "User-Agent": account.userAgent,
      "Accept": request.headers.get("Accept") || "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": request.headers.get("Accept-Language") || "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      "DNT": "1",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": request.headers.get("Sec-Fetch-Dest") || "document",
      "Sec-Fetch-Mode": request.headers.get("Sec-Fetch-Mode") || "navigate",
      "Sec-Fetch-Site": request.headers.get("Sec-Fetch-Site") || "none",
      "Sec-Fetch-User": "?1",
      "Referer": "https://grok.x.ai/",
      "Origin": "https://grok.x.ai",
      "Sec-Ch-Ua": `"Chromium";v="138", "Microsoft Edge";v="138", "Not=A?Brand";v="99"`,
      "Sec-Ch-Ua-Platform": `"Windows"`
    };

    let body: string | undefined;
    if (["POST", "PUT", "PATCH"].includes(request.method)) {
      body = await request.text();
      headers["Content-Type"] = request.headers.get("Content-Type") || "application/json";
      headers["Content-Length"] = body.length.toString();
    }

    // 处理 WebSocket 请求
    if (request.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(request);
      const wsUrl = grokUrl.replace(/^https/, "wss");
      
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        console.log(`WebSocket connected for ${accountId} to ${wsUrl}`);
      };
      ws.onmessage = (event) => socket.send(event.data);
      ws.onerror = (error) => {
        console.error(`WebSocket error for ${accountId}:`, error);
        socket.close();
      };
      ws.onclose = () => socket.close();

      socket.onmessage = (event) => ws.send(event.data);
      socket.onerror = (error) => {
        console.error(`Client WebSocket error for ${accountId}:`, error);
        ws.close();
      };
      socket.onclose = () => ws.close();

      return response;
    }

    const response = await fetch(grokUrl, {
      method: request.method,
      headers,
      body,
      redirect: "follow",
    });

    let responseBody = await response.arrayBuffer();
    const contentType = response.headers.get("Content-Type") || "";
    const responseText = contentType.includes("text/html") ? new TextDecoder().decode(responseBody) : "";

    // 检查 Cloudflare 验证页面
    if (responseText.includes("challenge-form") || responseText.includes("<title>Please wait...</title>")) {
      return new Response(
        JSON.stringify({
          error: "Cloudflare verification required",
          details: "Please update ACCOUNT1_COOKIES with fresh cookies from grok.x.ai",
          timestamp: new Date().toISOString()
        }),
        { 
          status: 403, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    if (contentType.includes("text/html")) {
      let htmlContent = responseText;
      const currentHost = new URL(request.url).origin;
      
      // 增强路径重写，处理相对路径、绝对路径和 Cloudflare 资源
      htmlContent = htmlContent
        .replace(/href="\/([^"]*?)"/g, `href="${currentHost}/proxy?account=${accountId}&path=/$1"`)
        .replace(/src="\/([^"]*?)"/g, `src="${currentHost}/proxy?account=${accountId}&path=/$1"`)
        .replace(/action="\/([^"]*?)"/g, `action="${currentHost}/proxy?account=${accountId}&path=/$1"`)
        .replace(/url\(\/([^)]+)\)/g, `url(${currentHost}/proxy?account=${accountId}&path=/$1)`)
        .replace(/url\("\/([^"]+)"\)/g, `url("${currentHost}/proxy?account=${accountId}&path=/$1")`)
        .replace(/url\('\/([^']+)'\)/g, `url('${currentHost}/proxy?account=${accountId}&path=/$1')`)
        .replace(/href="https:\/\/grok\.x\.ai\/([^"]*?)"/g, `href="${currentHost}/proxy?account=${accountId}&path=/$1"`)
        .replace(/src="https:\/\/grok\.x\.ai\/([^"]*?)"/g, `src="${currentHost}/proxy?account=${accountId}&path=/$1"`)
        .replace(/wss:\/\/grok\.x\.ai\/([^"]*?)"/g, `wss://${currentHost}/proxy?account=${accountId}&path=/$1"`)
        .replace(/cdn-cgi/g, `${currentHost}/proxy?account=${accountId}&path=/cdn-cgi`)
        .replace(
          "<head>",
          `<head>
          <style>
            .proxy-account-indicator {
              position: fixed !important;
              top: 10px !important;
              right: 10px !important;
              background: rgba(29, 155, 240, 0.9) !important;
              color: white !important;
              padding: 6px 12px !important;
              border-radius: 6px !important;
              font-size: 12px !important;
              z-index: 999999 !important;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
              font-weight: 500 !important;
              box-shadow: 0 2px 8px rgba(0,0,0,0.2) !important;
            }
          </style>
          <div class="proxy-account-indicator">🤖 ${accountId.toUpperCase()}</div>`
        );
      
      responseBody = new TextEncoder().encode(htmlContent).buffer;
    }

    const responseHeaders = new Headers(corsHeaders);
    const headersToKeep = [
      "Content-Type", "Cache-Control", "Expires", 
      "Last-Modified", "ETag", "Content-Encoding"
    ];
    
    headersToKeep.forEach(headerName => {
      const headerValue = response.headers.get(headerName);
      if (headerValue) {
        responseHeaders.set(headerName, headerValue);
      }
    });

    responseHeaders.set("Content-Length", responseBody.byteLength.toString());

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Proxy error:", error);
    return new Response(
      JSON.stringify({ 
        error: "Proxy request failed", 
        details: error.message,
        timestamp: new Date().toISOString()
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  }
}

// 静态文件服务
async function serveStaticFile(pathname: string): Promise<Response> {
  try {
    if (pathname === "/" || pathname === "") {
      pathname = "/index.html";
    }
    
    if (pathname.includes("..")) {
      return new Response("Forbidden", { status: 403 });
    }
    
    const filePath = `./public${pathname}`;
    
    try {
      const fileContent = await Deno.readFile(filePath);
      let contentType = "text/plain";
      if (pathname.endsWith(".html")) contentType = "text/html";
      else if (pathname.endsWith(".css")) contentType = "text/css";
      else if (pathname.endsWith(".js")) contentType = "application/javascript";
      else if (pathname.endsWith(".json")) contentType = "application/json";
      else if (pathname.endsWith(".png")) contentType = "image/png";
      else if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) contentType = "image/jpeg";
      else if (pathname.endsWith(".gif")) contentType = "image/gif";
      else if (pathname.endsWith(".svg")) contentType = "image/svg+xml";
      
      return new Response(fileContent, {
        headers: {
          ...corsHeaders,
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch {
      return new Response("File not found", { 
        status: 404,
        headers: corsHeaders,
      });
    }
  } catch (error) {
    return new Response("Server error", { 
      status: 500,
      headers: corsHeaders,
    });
  }
}

// 主请求处理器
async function handler(request: Request): Promise<Response> {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const url = new URL(request.url);
  const pathname = url.pathname;

  console.log(`${request.method} ${pathname}`);

  if (pathname.startsWith("/api/")) {
    const apiPath = pathname.replace("/api", "");
    
    switch (apiPath) {
      case "/accounts":
        const availableAccounts = Object.keys(ACCOUNTS).filter(
          key => ACCOUNTS[key].cookies
        );
        return new Response(
          JSON.stringify({ accounts: availableAccounts }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      case "/health":
        return new Response(
          JSON.stringify({ 
            status: "ok", 
            timestamp: new Date().toISOString(),
            accounts: Object.keys(ACCOUNTS).reduce((acc, key) => {
              acc[key] = { configured: !!ACCOUNTS[key].cookies };
              return acc;
            }, {} as Record<string, { configured: boolean }>)
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      case "/debug/account1":
        return await debugAccount("account1");

      default:
        const testMatch = apiPath.match(/^\/test\/(.+)$/);
        if (testMatch) {
          const accountId = testMatch[1];
          const testResult = await testAccount(accountId);
          return new Response(
            JSON.stringify(testResult),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        return new Response(
          JSON.stringify({ error: "API endpoint not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  }

  if (pathname === "/proxy") {
    const accountId = url.searchParams.get("account") || "account1";
    return await proxyGrokRequest(request, accountId);
  }

  if (pathname.startsWith("/account/")) {
    const accountId = pathname.substring("/account/".length);
    if (ACCOUNTS[accountId]) {
      const grokMainUrl = `/proxy?account=${accountId}&path=/`;
      return Response.redirect(new URL(grokMainUrl, request.url).href, 302);
    }
  }

  return await serveStaticFile(pathname);
}

// 启动服务器
const port = parseInt(Deno.env.get("PORT") || "8000");

console.log(`🚀 Grok代理服务启动在端口 ${port}`);
console.log(`📁 静态文件目录: ./public`);
console.log(`🔐 已配置账号: ${Object.keys(ACCOUNTS).filter(k => ACCOUNTS[k].cookies).join(", ")}`);

await serve(handler, { port });