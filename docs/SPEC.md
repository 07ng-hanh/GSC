# ThermaStock — Project Specification (SPEC)

> Cập nhật theo **Brief Bổ Sung #1** và **Brief Bổ Sung #2**: Toàn bộ hệ thống nhất quán cho **GÀ THỊT (`broiler`)**, bổ sung **Bộ lập kế hoạch làm mát dự đoán (Predictive Cooling Control)** dùng quy hoạch động tầm nhìn hữu hạn + dự báo thời tiết (Giả lập AR(1) / Open-Meteo / Persistence), đối sánh với 3 Baseline (`B1`, `B2`, `B3`) trên mô hình môi trường (Plant) độc lập, Hiệu chuẩn mô hình (`identifyModel`), Dịch chuyển khẩu phần (Temporal Feed Shifting), Firebase Realtime Database, và Tùy chỉnh theo loài.

## 1. BỐI CẢNH & MỤC TIÊU
1. **Nhất quán hoàn toàn cho GÀ THỊT (`broiler`)**: Chỉ số nhiệt-ẩm (`marai2001`), 3 mức stress (`Comfort`, `Heat stress`, `Severe heat stress`), quản lý tuổi đàn (`ageGateDays = 21`, nhiệt độ mục tiêu theo tuổi), bảo hiểm mô phỏng, nhật ký thủ công.
2. **Điều khiển làm mát DỰ ĐOÁN (Predictive Cooling Control — Brief Bổ Sung #2)**:
   - Thay thế luật chạm ngưỡng phản ứng trễ bằng **Bộ lập kế hoạch dự đoán (Finite-Horizon Dynamic Programming)** cân bằng giữa giảm thiểu stress nhiệt hiệu dụng ($\text{eTHI}$) và giảm thiểu điện năng tiêu thụ ($\text{kWh}$), sử dụng dự báo thời tiết vùng có khử lệch (bias correction) từ node ngoài trời.
   - Quạt chạy **nhiều mức tốc độ biến tần** (`F = {0, 0.4, 0.6, 0.8, 1.0}`); phun sương và rèm che nắng điều khiển bật/tắt (`0/1`).
   - Giữ luật chạm ngưỡng THI làm **Baseline B3** và làm nền tảng cho **Luật dự phòng (Predictive Rule-Based Fallback)**.
   - So sánh định lượng (bảng chỉ số + đường cong Pareto $\lambda \in [0, 1]$) giữa Planner và 3 phương án thông thường (`B1` Hẹn giờ, `B2` Thermostat nhiệt độ, `B3` Ngưỡng THI) trên mô hình môi trường (**Plant**) độc lập với mô hình bên trong của Planner.
   - Vai trò: **GỢI Ý + MÔ PHỎNG ĐÁNH GIÁ (`"Recommendation only"`)**. Không gửi lệnh xuống thiết bị thật, không có nút `"Apply"`.
3. **Dịch chuyển khẩu phần (Temporal Feed Shifting)**: Lịch ngừng cấp cám khung giờ nóng và 5 thẻ gợi ý hướng điều chỉnh công thức cám (`R1–R5`, `"DRAFT"`).
4. **Chế độ THỰC TẾ dùng Firebase Realtime Database** & **Tùy chỉnh theo loài (Milestone cuối)**.

---

## 2. NGUYÊN TẮC BẤT BIẾN
1. Mọi thuật toán nghiệp vụ nằm trong `/src/lib/domain` dưới dạng hàm thuần, tất định theo `seed`.
2. Mọi tham số đặc thù loài và tham số bộ điều khiển nằm trong `SpeciesProfile` (bao gồm `SpeciesProfile.controller`), có trường `source`: `"literature"` (kèm mã `S1–S10` trong [SOURCES.md](./SOURCES.md)), `"assumption"` hoặc `"user"`.
3. Mô hình bên trong của bộ lập kế hoạch (**Planner model**) **KHÔNG ĐƯỢC trùng** với mô hình mô phỏng môi trường (**Plant model**) để tránh kết quả đẹp giả tạo (chênh lệch tham số tối thiểu $\ge 10\%$, cấu trúc trạng thái khác nhau).
4. Luôn hiển thị banner `"SIMULATED DATA - not measured"`, cột `source`, nhãn `"simulated estimate"` cho mọi con số tiết kiệm điện/stress ở chế độ giả lập, và nhãn `"Recommendation only"` cho kế hoạch làm mát.
5. Khi dùng nguồn dự báo Open-Meteo (`CC BY 4.0` [`S10`]), bắt buộc hiển thị `"Weather data by Open-Meteo.com"` ở footer.

---

## 3. ĐẶC TẢ GÀ THỊT & CẬP NHẬT MỤC A5 (PHẦN A)
- **Công thức THI mặc định (`marai2001`) [`S1`]**:
  $$\text{THI} = T - (0.31 - 0.31 \times \text{RH}) \times (T - 14.4)$$
  - 3 mức stress [`S1`]: `THI < 26` (`Comfort`), `26 <= THI <= 29` (`Heat stress`), `THI > 29` (`Severe heat stress`).
- **Tuổi đàn (`ageDays = 28` mặc định, `ageGateDays = 21`) [`S3`, `S5`]**: Dưới 21 ngày tuổi là giai đoạn úm (`Brooding phase`), không chạy lập kế hoạch làm mát và không chạy Feed Shifting.
- **Cập nhật mục A5 (Luật chạm ngưỡng THI — dùng làm Baseline B3)**:
  - Cấp 1 quạt (`fan`): BẬT khi `THI >= 26`.
  - Cấp 2 phun sương (`mist`): BẬT khi `THI >= 28` **VÀ** thỏa ràng buộc cứng [`S7`]: **độ ẩm môi trường ngoài trời/cửa hút gió `< 75%` VÀ tốc độ gió trong chuồng $\ge 1.5\text{ m/s}$** (thay cho ngưỡng cũ `RH < 80%`).
  - Cấp 3 rèm (`curtain`): BẬT khi `THI >= 29`.
  - Hysteresis: `0.5 THI`, thời gian bật/tắt tối thiểu `5 phút`.

---

## 4. ĐIỀU KHIỂN LÀM MÁT DỰ ĐOÁN — PREDICTIVE COOLING CONTROL (BRIEF BỔ SUNG #2)

### 4.1 Đầu vào & Tầng Dự Báo Thời Tiết (`ForecastSource`)
- **Đo từ `DataSource`**: THI trong chuồng theo nhóm điều khiển (mặc định 1 nhóm lấy `median` các node hợp lệ trong chuồng), nhiệt độ/độ ẩm ngoài trời từ node `Outdoor Reference`, tuổi đàn, trạng thái thiết bị hiện tại.
- **Interface `ForecastSource.getForecast(lat, lon, horizonHours)`** trả mảng theo giờ `{ t, temp_c, rh_pct, shortwave_wm2, wind_ms }` (nội suy tuyến tính xuống bước $\Delta = 15\text{ phút}$):
  1. `SimulatedForecastSource`: Chuỗi ngoài trời của bộ giả lập cộng sai số tự tương quan theo thời gian **AR(1)** có `seed`, độ lệch chuẩn tăng theo giờ dự báo $h$: $\sigma_T(h) = 0.5 + 0.3h\text{ }^\circ\text{C}$, $\sigma_{\text{RH}}(h) = 3 + 1.5h\%$. Mức sai số chọn ở Settings: `none | low | high | outage`.
  2. `OpenMeteoForecastSource` [`S10`]: Gọi qua route handler server `/api/forecast` (cache `30–60 phút`, trả bản tốt gần nhất kèm `stale: true` khi lỗi mạng) tới `https://api.open-meteo.com/v1/forecast` với `hourly=temperature_2m,relative_humidity_2m,shortwave_radiation,wind_speed_10m&wind_speed_unit=ms&forecast_days=2&past_hours=3&timezone=GMT&elevation=15`. Vị trí mặc định: **Trạm Gia Lâm, Hà Nội (`Lat 21.041`, `Long 105.886`, độ cao `15m ASL`)**.
  3. `PersistenceForecastSource`: Lấy trung bình theo giờ của $N$ ngày gần nhất từ node `Outdoor Reference` dịch về cùng giờ hôm nay.
- **Khử lệch dự báo (`Bias Correction`)**: $\text{bias} = \text{mean}(\text{đo} - \text{dự báo})$ của $T_{\text{out}}$ và $\text{RH}_{\text{out}}$ trong `3 giờ` gần nhất, cộng vào dự báo tương lai và suy giảm theo hàm mũ $e^{-\Delta t / 3\text{h}}$.
- **Điều kiện dự báo không dùng được**: Thiếu, cũ hơn `3 giờ` (`staleAfterH = 3`), hoặc nguồn lỗi (`outage`) $\rightarrow$ tự động chuyển sang **Luật dự phòng (Mục 4.5)**.
- **Lưới thời gian**: Bước $\Delta = 15\text{ phút}$, tầm nhìn $H = 4\text{ giờ}$ (`16 bước`), lập lại kế hoạch mỗi `15 phút` theo **thời gian mô phỏng**.

### 4.2 Mô Hình Bên Trong Bộ Lập Kế Hoạch (Planner Model)
- Trạng thái $x[k] = \text{THI}_{\text{in}}[k]$, với $\text{THI}_{\text{out}}[k]$ tính bằng `marai2001` trên $(T_{\text{out}}, \text{RH}_{\text{out}})$ đã khử lệch:
  $$x[k+1] = x[k] + \frac{\Delta}{\tau}\left(x_{\text{eq}}[k] - x[k]\right)$$
  $$x_{\text{eq}}[k] = \text{THI}_{\text{out}}[k] + \delta_{\text{load}}(\text{age}) - g_{\text{vent}} f[k] - g_{\text{mist}} m[k] E[k] - g_{\text{cur}} c[k] S[k]$$
  - $f[k] \in F = \{0, 0.4, 0.6, 0.8, 1.0\}$, $m[k] \in \{0, 1\}$, $c[k] \in \{0, 1\}$.
  - $E[k] = \text{clamp}\left(\frac{\text{RH}_{\max} - \text{RH}_{\text{out}}[k]}{\text{RH}_{\max} - \text{RH}_{\text{ref}}}, 0, 1\right)$ với $\text{RH}_{\max} = 75\%$, $\text{RH}_{\text{ref}} = 40\%$.
  - $S[k] = \text{clamp}\left(\frac{\text{shortwave}[k]}{S_{\text{ref}}}, 0, 1\right)$ với $S_{\text{ref}} = 800\text{ W/m}^2$.
- **THI hiệu dụng (`effective THI`) [`S8`]**:
  $$\text{eTHI}[k] = x[k] - k_{\text{wc}} \cdot v_{\text{full}} \cdot f[k]$$
- **Ràng buộc cứng [`S7`]**: Chỉ cho phép $m[k] = 1$ khi $\text{RH}_{\text{out}}[k] < 75\%$ **VÀ** $v_{\text{full}} \cdot f[k] \ge 1.5\text{ m/s}$; chỉ lập kế hoạch khi $\text{ageDays} \ge \text{ageGateDays}$ (`21 ngày`).

### 4.3 Hàm Mục Tiêu ($J$) & Quy Hoạch Động (Finite-Horizon DP)
- **Hàm mục tiêu**:
  $$J = (1 - \lambda)\frac{\text{Stress}}{\text{StressRef}} + \lambda\frac{\text{kWh}}{\text{kWhRef}} + J_{\text{water}} + J_{\text{switch}} + J_{\text{terminal}}$$
  - $\text{Stress} = \sum_{k=0}^{15} S(\text{eTHI}[k]) \cdot \Delta_h$, với $S(e) = \max(0, e - 26)^2 + \kappa \max(0, e - 29)^2$ ($\kappa = 5$).
  - $\text{kWh} = \sum_{k=0}^{15} \left(N_f P_f f[k]^3 + P_{\text{mist}} m[k]\right)\Delta_h + E_{\text{curtain}} |c[k] - c[k-1]|$ [`S9`].
  - $\text{StressRef}$: Stress khi tắt toàn bộ làm mát ($f=0, m=0, c=0$) trên cùng tầm nhìn; $\text{kWhRef}$: Điện khi bật tối đa trên cùng tầm nhìn.
  - Phạt đóng ngắt: $\omega_f |f[k] - f[k-1]| + \omega_m |m[k] - m[k-1]| + \omega_c |c[k] - c[k-1]|$.
  - 3 mức $\lambda$ cài sẵn: `Comfort` ($\lambda = 0.2$), `Balanced` ($\lambda = 0.5$), `Eco` ($\lambda = 0.8$).
- **Quy hoạch động (DP)**:
  - Lưới $x \in [18, 38]$ bước `0.25` (`81` điểm nút) $\times$ hành động trước đó $(f_{\text{prev}}, m_{\text{prev}}, c_{\text{prev}})$ (tối đa `20` tổ hợp hành động).
  - Giải lùi từ $k = 15$ về $k = 0$, nội suy tuyến tính $V_{k+1}(x')$ theo $x'$. Thời gian chạy $< 200\text{ ms}$.
  - Xuất kế hoạch 16 bước kèm chuỗi giải thích dễ hiểu (ví dụ: `"Pre-cool: forecast outdoor THI peaks at 30.1 around 13:00; house lag tau=30 min, starting fans at 60% now"`).

### 4.4 Luật Dự Phòng (Predictive Rule-Based Fallback)
- Kích hoạt khi: dự báo lỗi/cũ hơn 3 giờ, mô hình chưa hiệu chuẩn và người dùng chọn mặc định an toàn, dữ liệu chuồng cũ hơn `10 phút`, hoặc người dùng chọn `"Rule-based"` ở Settings. Luôn hiển thị rõ lý do.
- $\text{THI}_{\text{pred}} = \text{THI}_{\text{now}} + \text{slope}_{30\text{m}} \times L$ ($L = 30\text{ phút}$).
- Mức quạt $f = \text{clamp}((\text{THI}_{\text{pred}} - 26) / (29 - 26), 0, 1)$ làm tròn **lên** tới mức gần nhất trong $F$. Phun sương bật khi $\text{THI}_{\text{pred}} \ge 28$ và thỏa ràng buộc cứng [`S7`]; rèm bật khi $\text{THI}_{\text{pred}} \ge 29$ hoặc bức xạ cao. Tắt khi $\text{THI}_{\text{pred}} < \text{ngưỡng} - 0.5$ trong $\ge 2$ bước liên tiếp.

### 4.5 Mô Phỏng Đánh Giá: Plant, Baselines (B1–B3) & Hiệu Chuẩn (`identifyModel`)
- **Plant model độc lập**: Có 2 biến trạng thái riêng $T_{\text{in}}$ và $\text{RH}_{\text{in}}$ với hằng số thời gian riêng; phun sương hạ $T_{\text{in}}$ nhưng làm tăng $\text{RH}_{\text{in}}$; độ trễ cơ cấu chấp hành `5 phút` + thời gian tăng tốc quạt `2 phút`; nhiễu cảm biến; và độ lệch tham số $\pm 20\%$ theo seed (test bắt buộc khẳng định tham số Plant khác Planner ít nhất `10%`).
- **3 Baselines**: `B1` Hẹn giờ (`08:00–20:00`), `B2` Thermostat theo nhiệt độ khí ($26 / 28 / 30\text{ }^\circ\text{C}$ cho quạt `40 / 60 / 100%`, $31\text{ }^\circ\text{C}$ cho phun sương, trễ $1\text{ }^\circ\text{C}$), `B3` Luật chạm ngưỡng THI (`26 / 28 / 29`).
- **Hiệu chuẩn mô hình (`identifyModel`, P2)**: Hồi quy bình phương tối thiểu ước lượng $(\tau, \delta_{\text{load}}, g_{\text{vent}}, g_{\text{mist}}, g_{\text{cur}})$ từ nhật ký vận hành; khôi phục tham số trong $\pm 25\%$ trên dữ liệu thử bước giả lập; tài liệu `/docs/calibration-protocol.md`.

---

## 5. LỘ TRÌNH MILESTONE (ĐÃ ĐÁNH SỐ LẠI THEO BRIEF BỔ SUNG #2)
- **M1**: Khung dự án + Lõi nghiệp vụ cơ bản + Kiểm thử (Đã hoàn thành).
- **M2**: Bộ giả lập tất định + Trang Overview + Sơ đồ 2D chuồng gà (Đã hoàn thành).
- **M3**: Nhất quán hóa toàn diện cho Gà Thịt (`SpeciesProfile`, `marai2001`, tuổi đàn, kịch bản A7, khí hậu ngoài trời Việt Nam/Nam Á) (Đã hoàn thành).
- **M4 (`CO1` — Tầng dự báo thời tiết)**: `ForecastSource`, `SimulatedForecastSource` (AR(1)), `OpenMeteoForecastSource` + route `/api/forecast` có cache, khử lệch `bias correction`, `PersistenceForecastSource`, và unit test.
- **M5 (`CO2` — Lõi lập kế hoạch dự đoán)**: `SpeciesProfile.controller`, mô hình Planner (mục 2), hàm mục tiêu (mục 3), quy hoạch động DP (mục 4), luật dự phòng Fallback (mục 5), và unit test `(a)–(h)`.
- **M6 (`CO3` — Mô hình Plant + Baselines B1/B2/B3 + So sánh Pareto)**: Mô hình môi trường Plant 2 trạng thái $(T_{\text{in}}, \text{RH}_{\text{in}})$ độc lập với Planner, 3 baseline `B1/B2/B3`, bộ tính chỉ số, đường cong Pareto, và kiểm thử kịch bản trên tập seed tinh chỉnh `{1..5}` & seed kiểm chứng `{101..105}`.
- **M7 (`CO4` — Giao diện Làm mát Dự đoán & So sánh)**: Trang `Cooling Plan`, trang `Compare` (chạy trong Web Worker), cập nhật `Overview` (hiển thị gợi ý `"Recommendation only"` + lý do ngắn), cập nhật `Settings` (thanh trượt Comfort ↔ Energy, chế độ Optimizer/Rule-based, cấu hình dự báo, tọa độ, mức quạt), và footer ghi công Open-Meteo.
- **M8 (`CO5` — Hiệu chuẩn mô hình P2)**: Hàm `identifyModel()` bằng bình phương tối thiểu, trạng thái `"Uncalibrated (defaults)"` / `"Calibrated (date, R²)"` trên UI, kiểm thử khôi phục tham số $\pm 25\%$, và tài liệu `/docs/calibration-protocol.md`.
- **M9**: Lõi thuật toán Dịch chuyển khẩu phần (Temporal Feed Shifting B3) + Thẻ gợi ý `R1–R5` & unit test (Đã hoàn thành).
- **M10**: Giao diện trang `Feeding` (biểu đồ 24h, lịch ăn gợi ý, xác nhận chuyên gia, thẻ `R1–R5`) (Đã hoàn thành).
- **M11**: Trang `Trends` + Xuất CSV + Điều khiển tuổi đàn đầy đủ (Đã hoàn thành).
- **M12**: Quy tắc chất lượng dữ liệu nâng cao + Trang `Alerts` + Kiểm chứng kịch bản lỗi (Đã hoàn thành).
- **M13**: Trang `Energy & Water` + Trang `Insurance` (kèm nhật ký gà thịt thủ công) (Đã hoàn thành).
- **M14**: Khung Firebase Realtime Database (`FirebaseDataSource` stub, `database.rules.json`, `/docs/live-mode.md`) (Đã hoàn thành).
- **M15**: Hoàn thiện responsive, `README.md`, hướng dẫn deploy Vercel, đồng bộ tài liệu (Đã hoàn thành).
- **M16 (Milestone CUỐI — Tùy chỉnh theo loài)**: Trang quản lý `SpeciesProfile` (bao gồm chỉnh sửa toàn bộ tham số `SpeciesProfile.controller` ở mục 9, `customParams`, công thức `dbwb` / `nrc1971`, kiểm tra schema và xuất/nhập JSON) (Đã hoàn thành).
