document.addEventListener("DOMContentLoaded", () => {
  // Use same-origin so calls go to the Node gateway serving this frontend.
  const API_BASE_URL = window.location.origin.startsWith("http")
    ? window.location.origin
    : "http://localhost:3000";
  const ASSETS_BASE_URL = "assets";
  const AUTH_STORAGE_KEY = "cropsense_user";
  const AUTH_TOKEN_STORAGE_KEY = "cropsense_token";

  function saveSignedInUser(user) {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
  }

  function saveAuthToken(token) {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  }

  function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  }

  function clearSignedInUser() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  }

  function getSignedInUser() {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function renderNavGreeting() {
    const greetingEl = document.getElementById("user-greeting");
    const logoutBtn = document.getElementById("logout-btn");
    const authEntryEls = document.querySelectorAll("[data-auth-entry]");
    if (!greetingEl) return;

    const user = getSignedInUser();
    const token = getAuthToken();
    if (!user || !token) {
      if (user || token) clearSignedInUser();
      greetingEl.classList.add("hidden");
      greetingEl.textContent = "";
      if (logoutBtn) logoutBtn.classList.add("hidden");
      authEntryEls.forEach((el) => el.classList.remove("hidden"));
      return;
    }

    const preferredName = user.first_name || user.email || "user";
    greetingEl.textContent = `Hello @${preferredName}`;
    greetingEl.classList.remove("hidden");
    if (logoutBtn) logoutBtn.classList.remove("hidden");
    authEntryEls.forEach((el) => el.classList.add("hidden"));
  }

  function getCropImage(cropName) {
    const key = String(cropName || "").trim().toLowerCase();
    const map = {
      rice: `${ASSETS_BASE_URL}/crop-rice.svg`,
      maize: `${ASSETS_BASE_URL}/crop-maize.svg`,
      cotton: `${ASSETS_BASE_URL}/crop-cotton.svg`,
      coffee: `${ASSETS_BASE_URL}/crop-coffee.svg`,
      chickpea: `${ASSETS_BASE_URL}/crop-chickpea.svg`,
    };
    return map[key] || `${ASSETS_BASE_URL}/crop-generic.svg`;
  }



  renderNavGreeting();
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      clearSignedInUser();
      window.location.href = "login.html";
    });
  }

  // Auth logic (only on login page)
  const signinTab = document.getElementById("signin-tab");
  const signupTab = document.getElementById("signup-tab");
  const authForm = document.getElementById("auth-form");
  const authBtn = document.getElementById("auth-btn");
  const helperText = document.getElementById("auth-helper-text");
  const confirmPasswordRow = document.getElementById(
    "auth-confirm-password-row"
  );

  if (signinTab && signupTab && authForm && authBtn && helperText && confirmPasswordRow) {
    let authMode = "signin"; // or "signup"

    function setAuthMode(mode) {
      authMode = mode;

      if (mode === "signin") {
        signinTab.classList.add("active");
        signupTab.classList.remove("active");
        confirmPasswordRow.style.display = "none";
        document.getElementById("auth-name-row").style.display = "none";
        authBtn.textContent = "Sign in";
        helperText.innerHTML = "";
      } else {
        signinTab.classList.remove("active");
        signupTab.classList.add("active");
        confirmPasswordRow.style.display = "flex";
        document.getElementById("auth-name-row").style.display = "flex";
        authBtn.textContent = "Create account";
        helperText.innerHTML =
          'Already have an account? Switch to <button type="button" class="link-btn" id="inline-signin">Sign in</button>.';
      }

      // Re-bind inline switch buttons (they get recreated via innerHTML)
      bindInlineAuthSwitches();
    }

    function bindInlineAuthSwitches() {
      const inlineSignupBtn = document.getElementById("inline-signup");
      const inlineSigninBtn = document.getElementById("inline-signin");

      if (inlineSignupBtn) {
        inlineSignupBtn.addEventListener("click", () => setAuthMode("signup"));
      }
      if (inlineSigninBtn) {
        inlineSigninBtn.addEventListener("click", () => setAuthMode("signin"));
      }
    }

    // Initial bindings
    const initialInlineSignup = document.getElementById("inline-signup");
    if (initialInlineSignup) {
      initialInlineSignup.addEventListener("click", () => setAuthMode("signup"));
    }

    signinTab.addEventListener("click", () => setAuthMode("signin"));
    signupTab.addEventListener("click", () => setAuthMode("signup"));

    authForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const email = authForm.email.value.trim();
      const password = authForm.password.value.trim();

      if (!email || !password) {
        alert("Please fill in all required fields.");
        return;
      }

      authBtn.disabled = true;
      authBtn.textContent = "Please wait...";

      try {
        if (authMode === "signup") {
          const confirmPassword = authForm.confirmPassword.value.trim();
          const firstName = authForm.firstName.value.trim();
          const lastName = authForm.lastName.value.trim();

          if (password !== confirmPassword) {
            alert("Passwords do not match.");
            return;
          }
          if (!firstName || !lastName) {
            alert("Please provide your first and last name.");
            return;
          }

          const res = await fetch(`${API_BASE_URL}/signup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, firstName, lastName })
          });

          let data;
          try { data = await res.json(); } catch (e) { }
          if (!res.ok) throw new Error(data && data.detail ? data.detail : "Signup failed");

          alert("Account created successfully. Please sign in to continue.");
          authForm.reset();
          setAuthMode("signin");
          authForm.email.value = email;
        } else {
          const res = await fetch(`${API_BASE_URL}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
          });

          let data;
          try { data = await res.json(); } catch (e) { }
          if (!res.ok) throw new Error(data && data.detail ? data.detail : "Login failed");

          if (!data || !data.token) {
            throw new Error("Login succeeded but no token was returned.");
          }
          saveAuthToken(data.token);
          saveSignedInUser(data.user || {});
          const displayName = data && data.user && data.user.first_name ? data.user.first_name : "User";
          alert(`Login successful. Welcome ${displayName}! Redirecting to home page...`);
          window.location.href = "index.html"; // Forward to the app!
        }
      } catch (err) {
        alert(err.message);
      } finally {
        authBtn.disabled = false;
        authBtn.textContent = authMode === "signup" ? "Create account" : "Sign in";
      }
    });

    // Initial state for login page
    setAuthMode("signin");
  }

  // Crop form and mock recommendation (only on main page)
  const cropForm = document.getElementById("crop-form");
  const recommendationOutput = document.getElementById(
    "recommendation-output"
  );

  if (cropForm && recommendationOutput) {
    const signedInUser = getSignedInUser();
    const authToken = getAuthToken();
    if (!signedInUser || !authToken) {
      window.location.href = "login.html";
      return;
    }

    // Season preview element
    const seasonPreview = document.getElementById("season-preview") || cropForm.parentNode.querySelector('.season-preview');

    // ... existing submit handler ...
    const fetchBtn = document.getElementById("fetch-location-btn");
    const statusMsg = document.getElementById("location-status");

    // Season change handler for preview ✅ INTEGRATED
    const seasonSelect = cropForm.querySelector('#season');
    if (seasonSelect && seasonPreview) {
      seasonSelect.addEventListener('change', async (e) => {
        const season = e.target.value;
        if (!season) {
          seasonPreview.innerHTML = '';
          seasonPreview.classList.add('hidden');
          return;
        }

        try {
          seasonPreview.innerHTML = '<span class="loading">Loading season recs...</span>';
          seasonPreview.classList.remove('hidden');

          const res = await fetch(`${API_BASE_URL}/season-recs?season=${encodeURIComponent(season)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          
          const data = await res.json();

          const topCrop = Object.keys(data.top_crops)[0];
          const topCount = data.top_crops[topCrop];
          const modelTopProb = data.model_probs ? 
            Object.entries(data.model_probs).sort((a,b)=>b[1]-a[1])[0] : null;
          const modelTop = modelTopProb ? modelTopProb[0] : topCrop;

          seasonPreview.innerHTML = `
            <div class="preview-main">
              <strong>${season}:</strong> ${topCrop} 
              <span class="preview-count">(${topCount} farms)</span>
            </div>
            ${data.model_probs ? `
              <div class="preview-probs">
                Model top: ${modelTop} (${(modelTopProb[1]*100).toFixed(0)}%)
                ${Object.entries(data.model_probs).slice(1,4).map(([c,p])=>
                  `<span class="small">${c}: ${(p*100).toFixed(0)}%</span>`
                ).join('')}
              </div>
            ` : ''}
          `;
        } catch (err) {
          seasonPreview.innerHTML = '<span class="error">Season preview unavailable</span>';
          console.warn('Season recs fetch failed:', err);
        }
      });
      // Trigger initial preview if season pre-selected
      seasonSelect.dispatchEvent(new Event('change'));
    }


    async function fetchFallbackWeather(lat, lon) {
      const refinedWeatherResp = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation&daily=precipitation_sum&timezone=auto`);
      const refinedData = await refinedWeatherResp.json();
      return {
        temp: refinedData.current.temperature_2m,
        humidity: refinedData.current.relative_humidity_2m,
        rainfall: refinedData.daily.precipitation_sum[0] || 0
      };
    }

    async function populateByCoordinates(latitude, longitude) {
      // 1. Fetch Location Name (Reverse Geocoding) - non-blocking
      let locationText = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
      try {
        const geoResp = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`);
        if (geoResp.ok) {
          const geoData = await geoResp.json();
          locationText = geoData.display_name || locationText;
        }
      } catch (geoErr) {
        console.warn("Reverse geocoding failed, using coordinates.", geoErr);
      }

      // 2. Fetch Weather Data
      const WEATHER_API_KEY = "1df6ffcaf1042c8ff7fd96fb421e903a";
      let temp = null, humidity = null, rainfall = null;
      if (WEATHER_API_KEY) {
        try {
          const weatherResp = await fetch(`https://api.weatherapi.com/v1/current.json?key=${WEATHER_API_KEY}&q=${latitude},${longitude}`);
          const weatherData = await weatherResp.json();
          temp = weatherData.current.temp_c;
          humidity = weatherData.current.humidity;
          rainfall = weatherData.current.precip_mm || 0;
        } catch (e) {
          console.warn("WeatherAPI.com failed, falling back to Open-Meteo", e);
          const fallback = await fetchFallbackWeather(latitude, longitude);
          temp = fallback.temp;
          humidity = fallback.humidity;
          rainfall = fallback.rainfall;
        }
      } else {
        const fallback = await fetchFallbackWeather(latitude, longitude);
        temp = fallback.temp;
        humidity = fallback.humidity;
        rainfall = fallback.rainfall;
      }

      // 3. Fetch Soil Data
      let soilData = { n: 70, p: 45, k: 40, ph: 6.5 };
      try {
        const soilResp = await fetch(`https://api.isric.org/soilgrids/v2.0/properties/query?lon=${longitude}&lat=${latitude}&property=nitrogen&property=phh2o&property=soc&depth=0-5cm&value=mean`);
        if (soilResp.ok) {
          const sData = await soilResp.json();
          const phRaw = sData.properties.layers.find(l => l.name === 'phh2o').depths[0].values.mean;
          soilData.ph = phRaw / 10;
          const nRaw = sData.properties.layers.find(l => l.name === 'nitrogen').depths[0].values.mean;
          soilData.n = nRaw / 10;
        }
      } catch (e) {
        console.warn("Soil API failed, using regional defaults", e);
      }

      if (temp != null) cropForm.temperature.value = temp;
      if (humidity != null) cropForm.humidity.value = humidity;
      if (rainfall != null) cropForm.rainfall.value = rainfall;
      cropForm.location.value = locationText;
      cropForm.nitrogen.value = soilData.n;
      cropForm.phosphorus.value = soilData.p;
      cropForm.potassium.value = soilData.k;
      cropForm.ph.value = soilData.ph.toFixed(1);
    }

    async function getApproxCoordinatesFromIP() {
      const ipResp = await fetch("https://ipapi.co/json/");
      if (!ipResp.ok) throw new Error("IP geolocation failed");
      const ipData = await ipResp.json();
      if (typeof ipData.latitude !== "number" || typeof ipData.longitude !== "number") {
        throw new Error("IP geolocation missing coordinates");
      }
      return { latitude: ipData.latitude, longitude: ipData.longitude };
    }

    if (fetchBtn) {
      fetchBtn.addEventListener("click", async () => {
        updateStatus("Fetching location...", "info");
        fetchBtn.classList.add("loading");
        fetchBtn.disabled = true;

        const finalize = () => {
          fetchBtn.classList.remove("loading");
          fetchBtn.disabled = false;
        };

        if (!navigator.geolocation) {
          try {
            const approx = await getApproxCoordinatesFromIP();
            await populateByCoordinates(approx.latitude, approx.longitude);
            updateStatus("Values updated using approximate location.", "success");
          } catch (err) {
            updateStatus("Could not auto-fetch location. Enter location manually.", "error");
          } finally {
            finalize();
          }
          return;
        }

        navigator.geolocation.getCurrentPosition(
          async (position) => {
            try {
              updateStatus("Filling values...", "info");
              const { latitude, longitude } = position.coords;
              await populateByCoordinates(latitude, longitude);
              updateStatus("Values filled.", "success");
            } catch (error) {
              console.error(error);
              updateStatus("Unable to fill values. Try again.", "error");
            } finally {
              finalize();
            }
          },
          async () => {
            // Permission denied/unavailable/timeout -> use IP-based fallback
            try {
              updateStatus("Fetching location...", "info");
              const approx = await getApproxCoordinatesFromIP();
              updateStatus("Filling values...", "info");
              await populateByCoordinates(approx.latitude, approx.longitude);
              updateStatus("Values filled.", "success");
            } catch (err) {
              updateStatus("Unable to fill values. Try again.", "error");
            } finally {
              finalize();
            }
          },
          { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
        );
      });
    }

    function updateStatus(msg, type) {
      if (!statusMsg) return;
      statusMsg.textContent = msg;
      statusMsg.className = `status-message ${type}`;
      statusMsg.classList.remove("hidden");
    }

    cropForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const values = {
        nitrogen: Number(cropForm.nitrogen.value),
        phosphorus: Number(cropForm.phosphorus.value),
        potassium: Number(cropForm.potassium.value),
        temperature: Number(cropForm.temperature.value),
        humidity: Number(cropForm.humidity.value),
        ph: Number(cropForm.ph.value),
        rainfall: Number(cropForm.rainfall.value),
        season: cropForm.season.value,
        location: cropForm.location.value.trim(),
      };

      renderLoading();

      try {
        const apiPayload = {
          N: values.nitrogen,
          P: values.phosphorus,
          K: values.potassium,
          temperature: values.temperature,
          humidity: values.humidity,
          ph: values.ph,
          rainfall: values.rainfall,
          Season: values.season,
          location: values.location || "India",
        };

        const result = await predictViaBackend(apiPayload);
        renderBackendRecommendation(result, values);
      } catch (err) {
        console.error("Backend fetch error:", err);
        renderBackendError(values, err);
      }
    });
  }





  async function predictViaBackend(payload) {
    const token = getAuthToken();
    if (!token) {
      throw new Error("Session expired. Please sign in again.");
    }

    const res = await fetch(`${API_BASE_URL}/predict`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }

    if (!res.ok) {
      const detail = data && data.detail ? String(data.detail) : `HTTP ${res.status}`;
      const lowerDetail = detail.toLowerCase();
      if (res.status === 401 || lowerDetail.includes("expired token") || lowerDetail.includes("invalid token")) {
        clearSignedInUser();
        window.location.href = "login.html";
        throw new Error("Session expired. Please sign in again.");
      }
      throw new Error(detail);
    }

    return data;
  }

  function mockRecommend(values) {
    // Simple, front‑end only heuristic to show the UI; replace with your ML API.
    const { nitrogen, phosphorus, potassium, temperature, humidity, ph, rainfall } =
      values;

    let crop = "Rice";
    let confidence = 0.82;

    if (rainfall > 150 && humidity > 80) {
      crop = "Rice";
      confidence = 0.9;
    } else if (ph >= 6 && ph <= 7.5 && temperature >= 20 && temperature <= 28) {
      crop = "Maize";
      confidence = 0.88;
    } else if (temperature > 25 && rainfall < 100 && ph > 5.5 && potassium > 40) {
      crop = "Cotton";
      confidence = 0.87;
    } else if (temperature > 24 && humidity > 70 && rainfall > 90 && ph > 5.5) {
      crop = "Coffee";
      confidence = 0.89;
    } else if (ph > 7 && rainfall < 80) {
      crop = "Chickpea";
      confidence = 0.84;
    }

    return {
      crop,
      confidence,
      topFeatures: [
        { name: "Nitrogen (N)", weight: relativeWeight(nitrogen) },
        { name: "Phosphorus (P)", weight: relativeWeight(phosphorus) },
        { name: "Potassium (K)", weight: relativeWeight(potassium) },
        { name: "Soil pH", weight: relativeWeight(ph, 0, 14) },
        { name: "Rainfall", weight: relativeWeight(rainfall) },
      ],
    };
  }

  function relativeWeight(value, min = 0, max = 200) {
    const clamped = Math.max(min, Math.min(max, value));
    const norm = (clamped - min) / (max - min || 1);
    return (0.4 + norm * 0.6).toFixed(2); // 0.4–1.0
  }

  function renderLoading() {
    if (!recommendationOutput) return;
    recommendationOutput.innerHTML = `
      <p class="placeholder">Getting prediction from backend (Random Forest + SHAP)…</p>
    `;
  }

  function renderBackendRecommendation(result, values) {
    if (!recommendationOutput) return;

    const recommended = result.recommended_crop;
    const confPct = (Number(result.confidence) * 100).toFixed(1);
    const locText = values.location ? values.location : "Not specified";

    const probs = result.class_probabilities || {};
    const topProbEntries = Object.entries(probs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const shap = Array.isArray(result.shap_explanation) ? result.shap_explanation : [];

    // Build mandi prices section
    const marketPrices = Array.isArray(result.market_prices) ? result.market_prices : [];
    const priceSummary = result.price_summary || null;
    const estimatedInvestment = Number(result.estimated_investment || 0);
    const estimatedProfit = Number(result.estimated_profit || 0);
    const estimatedInvestmentPerAcre = Number(result.estimated_investment_per_acre || 0);
    const estimatedProfitPerAcre = Number(result.estimated_profit_per_acre || 0);
    const assumedYieldQuintalPerAcre = Number(result.assumed_yield_quintal_per_acre || 10);
    const marketInsight = result.market_insight ? String(result.market_insight) : "";

    let mandiSummaryHTML = '';
    if (priceSummary || estimatedInvestment > 0 || estimatedProfit > 0) {
      const investmentPerAcreValue = estimatedInvestmentPerAcre > 0
        ? estimatedInvestmentPerAcre
        : (estimatedInvestment > 0
          ? estimatedInvestment * assumedYieldQuintalPerAcre
          : Number(priceSummary && priceSummary.min_price ? priceSummary.min_price : 0) * assumedYieldQuintalPerAcre);
      const profitPerAcreValue = estimatedProfitPerAcre > 0
        ? estimatedProfitPerAcre
        : (estimatedProfit > 0
          ? estimatedProfit * assumedYieldQuintalPerAcre
        : Number(
          priceSummary
            ? (Number(priceSummary.avg_modal_price || 0) - Number(priceSummary.min_price || 0))
            : 0
        ) * assumedYieldQuintalPerAcre);
      const avgModalValue = Number(priceSummary && priceSummary.avg_modal_price ? priceSummary.avg_modal_price : 0);

      mandiSummaryHTML = `
        <div class="financial-row">
          <div class="financial-card investment">
            <div class="fin-label">Estimated Investment</div>
            <div class="fin-value">₹${investmentPerAcreValue.toLocaleString()} <span class="unit">/ acre</span></div>
          </div>
          <div class="financial-card profit">
            <div class="fin-label">Estimated Profit</div>
            <div class="fin-value">₹${Math.max(0, profitPerAcreValue).toLocaleString()} <span class="unit">/ acre</span></div>
          </div>
          <div class="financial-card investment">
            <div class="fin-label">Avg Market Price</div>
            <div class="fin-value">₹${avgModalValue.toLocaleString()} <span class="unit">/ quintal</span></div>
          </div>
        </div>
        <p class="placeholder" style="margin-top:0.4rem;">Per-acre values use assumed yield ${assumedYieldQuintalPerAcre.toFixed(1)} quintal/acre.</p>
        ${marketInsight ? `<p class="placeholder" style="margin-top:0.4rem;">${escapeHtml(marketInsight)}</p>` : ""}
      `;
    }

    let mandiTableHTML = '';
    if (marketPrices.length > 0) {
      mandiTableHTML = `
        <div class="output-section extra-insight">
          <div class="output-section-title">
            <span>Live Mandi Prices</span>
            <span class="output-section-badge">data.gov.in</span>
          </div>
          <div class="mandi-table-wrap">
            <table class="mandi-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>State</th>
                  <th>Variety</th>
                  <th>Min ₹</th>
                  <th>Max ₹</th>
                  <th>Modal ₹</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                ${marketPrices.map(r => `
                  <tr>
                    <td>${escapeHtml(r.market || '')}</td>
                    <td>${escapeHtml(r.state || '')}</td>
                    <td>${escapeHtml(r.variety || '')}</td>
                    <td>₹${Number(r.min_price).toLocaleString()}</td>
                    <td>₹${Number(r.max_price).toLocaleString()}</td>
                    <td>₹${Number(r.modal_price).toLocaleString()}</td>
                    <td>${escapeHtml(r.arrival_date || '-')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
    } else {
      mandiTableHTML = `
        <div class="output-section extra-insight">
          <div class="output-section-title">
            <span>Live Mandi Prices</span>
            <span class="output-section-badge">data.gov.in</span>
          </div>
          <p class="placeholder" style="margin-top:0.5rem;">No mandi price data available for this commodity.</p>
        </div>`;
    }

    recommendationOutput.innerHTML = `
      <div class="rec-badge">
        <span>${recommended}</span>
        <span>•</span>
        <span>${confPct}% confidence</span>
      </div>
      <p class="rec-title">Suggested crop: ${recommended}</p>
      <div class="rec-meta">
        <span class="rec-chip">Location: ${locText}</span>
        <span class="rec-chip">N: ${values.nitrogen}</span>
        <span class="rec-chip">P: ${values.phosphorus}</span>
        <span class="rec-chip">K: ${values.potassium}</span>
        <span class="rec-chip">Temp: ${values.temperature} °C</span>
        <span class="rec-chip">Humidity: ${values.humidity}%</span>
        <span class="rec-chip">pH: ${values.ph.toFixed(2)}</span>
        <span class="rec-chip">Rainfall: ${values.rainfall} mm</span>
        <span class="rec-chip">Season: ${values.season || 'N/A'}</span>
      </div>

      ${mandiSummaryHTML}
      ${mandiTableHTML}


      <div class="output-section probability">
        <div class="output-section-title">
          <span>Top class probabilities</span>
          <span class="output-section-badge">Random Forest</span>
        </div>
        <div class="probability-rows">
          ${topProbEntries
        .map(([name, p], idx) => {
          const pct = Math.max(0, Math.min(100, p * 100));
          const isTop = idx === 0 ? "top" : "";
          return `
                <div class="prob-row ${isTop}">
                  <img
                    class="prob-thumb"
                    src="${getCropImage(name)}"
                    alt="${escapeHtml(String(name))} sample image"
                    loading="lazy"
                  />
                  <div class="prob-name">${escapeHtml(String(name))}</div>
                  <div class="prob-bar" aria-label="Probability bar">
                    <div class="prob-fill" style="width: ${pct.toFixed(1)}%"></div>
                  </div>
                  <div class="prob-value">${pct.toFixed(1)}%</div>
                </div>
              `;
        })
        .join("")}
        </div>
      </div>

      <div class="output-section explanation">
        <div class="output-section-title">
          <span>SHAP explanation (top features)</span>
          <span class="output-section-badge">Explainable AI</span>
        </div>
        <ul class="explanation-list">
          ${shap.length
        ? shap
          .map((row) => {
            const w = Number(row.weight);
            const pillClass = Number.isFinite(w)
              ? w >= 0
                ? "positive"
                : "negative"
              : "";
            const weightText = Number.isFinite(w) ? w.toFixed(4) : "N/A";
            const sign = Number.isFinite(w) ? (w >= 0 ? "+" : "") : "";
            return `
                      <li>
                        ${escapeHtml(String(row.feature))}
                        <span class="weight-pill ${pillClass}">${sign}${escapeHtml(weightText)}</span>
                      </li>
                    `;
          })
          .join("")
        : "<li>No explanation returned.</li>"
      }
        </ul>
        <button type="button" class="link-btn" id="toggle-explanation-backend">
          Show more explanation
        </button>
        <div class="explanation-extra hidden" id="explanation-extra-backend">
          <p class="placeholder">
            SHAP explains this prediction by computing the marginal contribution
            of each feature. Features with larger positive weights push
            the model towards the suggested crop; negative weights push it away.
          </p>
        </div>
      </div>
    `;

    const toggle = document.getElementById("toggle-explanation-backend");
    const extra = document.getElementById("explanation-extra-backend");
    if (toggle && extra) {
      toggle.addEventListener("click", () => {
        const isHidden = extra.classList.toggle("hidden");
        toggle.textContent = isHidden
          ? "Show more explanation"
          : "Hide explanation details";
      });
    }
  }

  function renderMockRecommendation(mock, values, err) {
    if (!recommendationOutput) return;

    const locText = values.location ? values.location : "Not specified";
    const confPct = (mock.confidence * 100).toFixed(1);
    const errText = err ? String(err.message || err) : "Backend unavailable";

    recommendationOutput.innerHTML = `
      <div class="rec-badge">
        <span>${mock.crop}</span>
        <span>•</span>
        <span>${confPct}% confidence (demo)</span>
      </div>
      <p class="rec-title">
        Suggested crop: ${mock.crop}
      </p>
      <div class="rec-meta">
        <span class="rec-chip">Location: ${locText}</span>
        <span class="rec-chip">N: ${values.nitrogen}</span>
        <span class="rec-chip">P: ${values.phosphorus}</span>
        <span class="rec-chip">K: ${values.potassium}</span>
        <span class="rec-chip">Temp: ${values.temperature} °C</span>
        <span class="rec-chip">Humidity: ${values.humidity}%</span>
        <span class="rec-chip">pH: ${values.ph.toFixed(2)}</span>
        <span class="rec-chip">Rainfall: ${values.rainfall} mm</span>
        <span class="rec-chip">Season: ${values.season || 'N/A'}</span>
      </div>

      <div class="output-section extra-insight">
        <div class="output-section-title">
          <span>Live Mandi Prices</span>
          <span class="output-section-badge">data.gov.in (Demo)</span>
        </div>
        <p class="placeholder" style="margin-top: 0.5rem;">
          Live mandi prices are available when the backend is running with a valid data.gov.in API key.
        </p>
      </div>


      <div class="output-section probability">
        <div class="output-section-title">
          <span>Top class probabilities</span>
          <span class="output-section-badge">Demo</span>
        </div>
        <div class="probability-rows">
          <div class="prob-row top">
            <img
              class="prob-thumb"
              src="${getCropImage(mock.crop)}"
              alt="${escapeHtml(String(mock.crop))} sample image"
              loading="lazy"
            />
            <div class="prob-name">${escapeHtml(String(mock.crop))}</div>
            <div class="prob-bar" aria-label="Probability bar">
              <div class="prob-fill" style="width: ${Math.min(
      100,
      Math.max(0, mock.confidence * 100)
    ).toFixed(1)}%"></div>
            </div>
            <div class="prob-value">${(mock.confidence * 100).toFixed(1)}%</div>
          </div>
        </div>
      </div>

      <div class="output-section explanation">
        <div class="output-section-title">
          <span>Explanation (mock XAI view)</span>
          <span class="output-section-badge">Demo</span>
        </div>
        <ul class="explanation-list">
          ${mock.topFeatures
        .map((f) => {
          const w = Number(f.weight);
          const weightText = Number.isFinite(w) ? w.toFixed(2) : String(f.weight);
          return `<li>${escapeHtml(String(f.name))}<span class="weight-pill positive">${escapeHtml(weightText)}</span></li>`;
        })
        .join("")}
        </ul>
      <button type="button" class="link-btn" id="toggle-explanation-mock">
        Show more explanation
      </button>
      <div class="explanation-extra hidden" id="explanation-extra-mock">
        <p class="placeholder">
          This is a simple front‑end heuristic that imitates how SHAP might
          highlight important features. Start the backend on
          <strong>port 8001</strong> with a dataset at
          <code>backend/data/crop_recommendation.csv</code>
          to see real Random Forest + SHAP explanations driven by your data.
        </p>
        <p class="placeholder" style="margin-top: 0.25rem;">
          Error from backend (for debugging): ${escapeHtml(errText)}.
        </p>
      </div>
      </div>
    `;

    const toggle = document.getElementById("toggle-explanation-mock");
    const extra = document.getElementById("explanation-extra-mock");
    if (toggle && extra) {
      toggle.addEventListener("click", () => {
        const isHidden = extra.classList.toggle("hidden");
        toggle.textContent = isHidden
          ? "Show more explanation"
          : "Hide explanation details";
      });
    }
  }

  function renderBackendError(values, err) {
    if (!recommendationOutput) return;
    const errText = err ? String(err.message || err) : "Unknown backend error";
    const locText = values.location ? values.location : "Not specified";

    recommendationOutput.innerHTML = `
      <div class="output-section extra-insight">
        <div class="output-section-title">
          <span>Prediction failed</span>
          <span class="output-section-badge">Backend</span>
        </div>
        <p class="placeholder" style="margin-top:0.5rem;">
          Could not fetch live prediction and mandi prices from backend.
        </p>
        <p class="placeholder" style="margin-top:0.25rem;">
          Error: ${escapeHtml(errText)}
        </p>
        <p class="placeholder" style="margin-top:0.25rem;">
          Location: ${escapeHtml(locText)}
        </p>
      </div>
    `;
  }

  function escapeHtml(str) {
    return str
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
});

