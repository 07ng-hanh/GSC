# ThermaStock — Tracked Assumptions & Placeholders (ASSUMPTIONS)

> Mọi ngưỡng, thông số thiết bị, tham số mô hình dự đoán, chi phí/bồi thường hoặc quy tắc biên không có trực tiếp trong tài liệu khoa học `S1–S10` ([SOURCES.md](./SOURCES.md)) đều được đánh dấu `source: "assumption"` và ghi nhận minh bạch tại đây.

## 1. Lưu ý quan trọng về Ngưỡng Stress Nhiệt Gà Thịt (`marai2001`)
- Công thức `marai2001` và 3 ngưỡng phân loại (`THI < 26`: `Comfort`; `26 <= THI <= 29`: `Heat stress`; `THI > 29`: `Severe heat stress`) được lấy từ một nghiên cứu gà thịt tại Nigeria (Omomowo & Falayi, 2021 [`S1`], trích gián tiếp từ Duduyemi & Oseni, 2012).
- **Cảnh báo học thuật**: Ngưỡng này được trích dẫn gián tiếp và phụ thuộc giống gà/khí hậu địa phương, **cần chuyên gia chăn nuôi/thú y xác nhận trước khi sử dụng trong báo cáo chính thức hoặc vận hành thực tế**.

## 2. Tuổi Đàn & Nhiệt Độ Mục Tiêu (`targetTempByAge`)
- **Tuổi đàn mặc định khi mở demo (`ageDays = 28`)**: Chọn `28 ngày` (`assumption`) làm mặc định để đàn gà đang ở giai đoạn gà thịt lớn (sau ngưỡng úm `21 ngày`), giúp người xem thấy ngay bộ lập kế hoạch làm mát dự đoán và Feed Shifting hoạt động; người dùng có thể đổi ngay trên thanh công cụ hoặc Settings.
- **Ngưỡng tuổi kết thúc giai đoạn úm (`ageGateDays = 21`, `assumption` tham khảo `S5`)**: Dưới 21 ngày tuổi, gà con cần sưởi ấm (brooding) nên hệ thống tự động tắt lập kế hoạch làm mát và tắt Dịch chuyển khẩu phần.
- **Mốc nhiệt độ mục tiêu từ ngày 28 trở đi (`24 °C`, `assumption`)**: Các mốc ngày 0 (`32 °C`), ngày 3 (`31 °C`), ngày 7 (`30 °C`), ngày 14 (`29 °C`), ngày 21 (`27 °C`) lấy từ tài liệu [`S3`] (UGA Extension B 1287, cột conventional brooder); mốc từ ngày 28 trở đi (`24 °C`) là giá trị giữ chỗ (`assumption`).

## 3. Khác Biệt Giữa THI Cảm Biến và THI Hiệu Dụng (`eTHI`) Của Bộ Lập Kế Hoạch Dự Đoán
- **Lý do tách $g_{\text{vent}}$ và $k_{\text{wc}}$**: Cảm biến nhiệt-ẩm trong chuồng chỉ đo nhiệt độ bầu khô $T$ và độ ẩm tương đối $\text{RH}$ nên **không nhìn thấy tốc độ gió** đi qua thân gà. Do đó, hiệu quả làm mát của quạt được mô hình hóa bằng 2 thành phần:
  1. $g_{\text{vent}}$ (`assumption = 1.0`): Trao đổi không khí đẩy nhiệt/ẩm tích tụ ra khỏi chuồng (tác động chậm vào trạng thái $x = \text{THI}_{\text{in}}$ với hằng số thời gian quán tính $\tau$).
  2. $k_{\text{wc}} \cdot v_{\text{full}} \cdot f$ (`k_wc = 0.8 THI/(m/s)`, `assumption`; $v_{\text{full}} = 3.0\text{ m/s}$ [`S7`]): Hiệu ứng gió lùa làm mát đối lưu trực tiếp lên đàn gà gần như tức thì ($\text{eTHI}[k] = x[k] - k_{\text{wc}} \cdot v_{\text{full}} \cdot f[k]$).
- Tài liệu [`S8`] (Furlan và cs., 2000) cho thấy tốc độ gió `2 m/s` ở `29 °C` cải thiện rõ rệt khả năng thoát nhiệt của gà 36–42 ngày tuổi và phản ứng giảm nhiệt xuất hiện rõ ngay trong `10 phút` đầu tiếp xúc.
- **Lưu ý định luật lập phương công suất quạt [`S9`]**: Công thức $P_{\text{fan}}(f) = N_f \cdot P_f \cdot f^3$ là xấp xỉ theo định luật đồng dạng quạt; trong thực tế hiệu suất biến tần/mô-tơ và áp suất tĩnh tại cửa gió làm công suất ở mức tốc độ thấp cao hơn lý thuyết $f^3$ một chút.

## 4. Tham Số Giữ Chỗ Trong `SpeciesProfile.controller` (Cần hiệu chuẩn từ dữ liệu pilot — Mục 8)
Toàn bộ các tham số mô hình dự đoán dưới đây (trừ `vFullMps`, `mistMinAirSpeedMps`, `mistMaxAmbientRH` lấy từ [`S7`]) là giá trị giữ chỗ (`source: "assumption"`) và **cần được hiệu chuẩn bằng `identifyModel()` trên dữ liệu thử bước thực tế của chuồng pilot**:

| Tham số | Giá trị mặc định | Nguồn | Ý nghĩa & Ghi chú |
| --- | --- | --- | --- |
| `horizonHours` | `4` giờ | `assumption` | Tầm nhìn quy hoạch động ($H = 16$ bước). |
| `stepMin` / `replanMin` | `15` / `15` phút | `assumption` | Bước lưới thời gian $\Delta = 15\text{ phút}$ (tính theo đồng hồ mô phỏng). |
| `xGrid` | `[18, 38, 0.25]` | `assumption` | Lưới rời rạc trạng thái THI trong chuồng $x$ (`81` điểm nút). |
| `fanLevels` | `[0, 0.4, 0.6, 0.8, 1.0]` | `assumption` | Tập mức tốc độ quạt biến tần $F$. |
| `tauMin` ($\tau$) | `30` phút | `assumption` | Hằng số thời gian quán tính nhiệt của chuồng (cần hiệu chuẩn). |
| `gVent`, `gMist`, `gCur` | `1.0`, `1.5`, `0.5` | `assumption` | Độ lợi giảm THI cân bằng của quạt, phun sương, rèm (cần hiệu chuẩn). |
| `kWindChillPerMps` ($k_{\text{wc}}$) | `0.8` THI/(m/s) | `assumption` | Độ giảm eTHI tức thì trên mỗi m/s tốc độ gió. |
| `vFullMps` ($v_{\text{full}}$) | `3.0` m/s | `literature` (`S7`) | Tốc độ gió trung bình mục tiêu khi quạt chạy 100% (2.5–3.0 m/s). |
| `mistMinAirSpeedMps` | `1.5` m/s | `literature` (`S7`) | Tốc độ gió tối thiểu để được phép bật phun sương. |
| `mistMaxAmbientRH` | `75` % | `literature` (`S7`) | Độ ẩm ngoài trời/cửa hút tối đa cho phép bật phun sương ($\text{RH}_{\text{out}} < 75\%$). |
| `rhRef` ($\text{RH}_{\text{ref}}$) | `40` % | `assumption` | Độ ẩm tham chiếu đạt 100% hiệu suất bay hơi $E[k]$. |
| `solarRef` ($S_{\text{ref}}$) | `800` $\text{W/m}^2$ | `assumption` | Bức xạ ngắn tham chiếu đạt 100% hiệu quả che nắng của rèm $S[k]$. |
| `deltaLoadByAge` ($\delta_{\text{load}}$) | `21d: 0.3, 28d: 0.6, 35d: 1.0, 42d: 1.3` | `assumption` | Độ cộng thêm THI cân bằng do nhiệt sinh học của đàn gà theo tuổi. |
| `kappa` ($\kappa$) | `5` | `assumption` | Hệ số phạt bậc hai khi $\text{eTHI} > 29$ (vùng `Severe heat stress`). |
| `lambdaPresets` ($\lambda$) | `{ comfort: 0.2, balanced: 0.5, eco: 0.8 }` | `assumption` | Trọng số đánh đổi giữa Stress nhiệt và Điện năng tiêu thụ. |
| `switchWeights` ($\omega_f, \omega_m, \omega_c$) | `{ fan: 0.015, mist: 0.02, curtain: 0.02 }` | `assumption` | Hệ số phạt đổi trạng thái thiết bị giữa hai bước liên tiếp. |
| `waterWeight` | `0.02` | `assumption` | Trọng số nhỏ cho lượng nước phun chuẩn hóa trong hàm mục tiêu. |
| `terminalSteps` | `2` bước | `assumption` | Hệ số nhân chi phí trạng thái cuối tầm nhìn $V_N(x_N)$. |
| `biasWindowH` / `biasDecayH` / `staleAfterH` | `3` / `3` / `3` giờ | `assumption` | Cửa sổ tính độ lệch dự báo, hằng số suy giảm hàm mũ, và ngưỡng quá hạn dự báo. |
| `forecastSigma` | `T: 0.5 + 0.3h °C`, `RH: 3 + 1.5h %` | `assumption` | Độ lệch chuẩn sai số dự báo giả lập AR(1) theo bước dự báo $h$ (giờ), hệ số tự tương quan $\rho = 0.85$. |
| `fallback` | `{ leadMin: 30, hysteresis: 0.5, minRunMin: 5, staleDataMin: 10 }` | `assumption` | Tham số bộ điều khiển dự phòng hồi quy tuyến tính 30 phút. |

## 5. Ghi Chú Kiểm Chứng API Open-Meteo (`S10`) & Tọa Độ Mặc Định
- **Kiểm chứng tên biến trong tài liệu chính thức Open-Meteo (`/v1/forecast`)**:
  - `hourly=temperature_2m,relative_humidity_2m,shortwave_radiation,wind_speed_10m` hoàn toàn trùng khớp với tài liệu chính thức của Open-Meteo.
  - **Lưu ý đơn vị tốc độ gió (`wind_speed_unit=ms`)**: Mặc định Open-Meteo trả `wind_speed_10m` theo đơn vị **`km/h` (`kmh`)**. Để nhận đúng đơn vị $\text{m/s}$ cho trường `wind_ms`, URL gọi API **phải truyền thêm `wind_speed_unit=ms`**.
  - **Lưu ý múi giờ & cửa sổ quá khứ (`timezone=GMT&past_hours=3`)**: Truyền `timezone=GMT` (UTC) và `past_hours=3` để luôn có sẵn 3 giờ dự báo gần nhất phục vụ bước khử lệch (`bias correction`) kể cả khi gọi lúc đầu ngày UTC.
  - **Lưu ý `shortwave_radiation`**: Trong Open-Meteo, `shortwave_radiation` ($\text{W/m}^2$) tại mốc giờ $t$ là bức xạ trung bình của 1 giờ liền trước (preceding hour mean).
- **Tọa độ & trạm khí tượng mặc định (`assumption`)**: **Trạm Gia Lâm, Hà Nội** (`latitude = 21.041`, `longitude = 105.886`, độ cao `elevation = 15m ASL`), truyền kèm `elevation=15` khi gọi Open-Meteo `/v1/forecast`; người dùng có thể chỉnh tại trang Settings.

## 6. Mô Hình Môi Trường Giả Lập (Plant) và Ba Phương Án Baseline (B1, B2, B3)
- **Sự khác biệt bắt buộc giữa Plant và Planner (`assumption`)**:
  - Planner dùng 1 biến trạng thái gộp $x = \text{THI}_{\text{in}}$ với $\tau = 30\text{ phút}$.
  - Plant mô phỏng 2 biến vật lý riêng biệt $T_{\text{in}}$ và $\text{RH}_{\text{in}}$ với 2 hằng số thời gian khác nhau ($\tau_T \ne \tau_{\text{RH}}$), trong đó phun sương làm giảm $T_{\text{in}}$ nhưng **làm tăng $\text{RH}_{\text{in}}$**; có độ trễ cơ cấu chấp hành `5 phút`, thời gian tăng tốc quạt `2 phút`, nhiễu đo cảm biến và độ lệch tham số ngẫu nhiên $\pm 20\%$ theo seed (đảm bảo lệch tối thiểu $\ge 10\%$ so với tham số mặc định của Planner).
- **Ba phương án Baseline (`assumption`)**:
  - **B1 (Fixed Timer)**: Bật toàn bộ thiết bị (quạt 100%, phun sương nếu thỏa điều kiện an toàn, rèm) cố định từ `08:00` đến `20:00`.
  - **B2 (Air-Temperature Thermostat)**: Quạt `40%` khi $T_{\text{in}} \ge 26\text{ }^\circ\text{C}$, `60%` khi $T_{\text{in}} \ge 28\text{ }^\circ\text{C}$, `100%` khi $T_{\text{in}} \ge 30\text{ }^\circ\text{C}$; phun sương khi $T_{\text{in}} \ge 31\text{ }^\circ\text{C}$ (nếu thỏa ràng buộc phun sương); độ trễ tắt `1.0 °C`.
  - **B3 (Reactive THI Threshold — Mục A5 cập nhật)**: Bật quạt khi $\text{THI}_{\text{in}} \ge 26$, phun sương khi $\text{THI}_{\text{in}} \ge 28$ (khóa khi $\text{RH}_{\text{out}} \ge 75\%$ hoặc tốc độ gió $< 1.5\text{ m/s}$ [`S7`]), rèm khi $\text{THI}_{\text{in}} \ge 29$; độ trễ `0.5 THI`, giữ tối thiểu `5 phút`.

## 7. Bố Cục 4 Điểm Đo, Bảo Hiểm & Dịch Chuyển Khẩu Phần (`assumption`)
- Giữ nguyên bố cục 4 vùng đo (`zone-front` `-0.5 °C`, `zone-center` `0.0 °C`, `zone-rear` `+1.5 °C, +3% RH`, `zone-outdoor` đối chứng khí hậu Việt Nam/Nam Á đỉnh trưa `~35 °C`, trung bình ngày `~27 °C`), tham số bảo hiểm (`> 29` trong `3` ngày liên tiếp, `5,000,000 VND`) và tham số Dịch chuyển khẩu phần (`N = 3`, `lead = 3`, `lag = 3`, `maxWithdrawalHours = 8`, `minFeederHours = 16`, `coolBias = 0.5`).

## 8. Giả Định Kinh Tế & Tiết Kiệm Tài Nguyên (`assumption`)
- **Biểu giá điện (`2,000 VND/kWh`, `assumption`)**: Dựa trên biểu giá điện kinh doanh/nông nghiệp trung bình của Tập đoàn Điện lực Việt Nam (EVN).
- **Biểu giá nước nông nghiệp (`15,000 VND/m³` = `15 VND/L`, `assumption`)**: Giá nước cấp trang trại chăn nuôi công nghiệp.
- **Giá trị kinh tế gà thịt thương phẩm (`75,000 VND/con` ~ `$3.00 USD`, `assumption`)**: Dựa trên trọng lượng xuất chuồng trung bình 2.2–2.5 kg của giống Ross 308 tại thị trường Việt Nam (`[S3]`).
- **Hệ số phát thải carbon lưới điện (`0.72 kg CO2/kWh`, `assumption`)**: Hệ số phát thải trung bình của lưới điện quốc gia Việt Nam phục vụ ước tính lượng $\text{CO}_2$ giảm phát thải.

## 9. Khung Firebase Realtime Database & Chế Độ Thực Tế (`assumption`)
- **Ngưỡng nhịp tim nút cảm biến offline (`quality.offlineMinutes = 10 phút`, `assumption`)**: Nếu nút ESP32 không gửi bản tin telemetry sau 10 phút, hệ thống tự động đánh dấu `online: false` và phát sinh cảnh báo sự cố phần cứng.
- **Cơ chế ngắt kết nối an toàn (`NotConnectedError`, `assumption`)**: Khi chưa nạp thông tin xác thực Firebase vào biến môi trường, hệ thống chuyển sang trạng thái chờ an toàn và duy trì hoạt động thông suốt trên chế độ Giả lập.
