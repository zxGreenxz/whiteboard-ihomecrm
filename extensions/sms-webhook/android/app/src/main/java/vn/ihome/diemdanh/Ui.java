package vn.ihome.diemdanh;

import android.app.Activity;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** The small set of views every screen is assembled from. */
public final class Ui {
    public static final int INK = Color.rgb(22, 41, 57);
    public static final int MUTED = Color.rgb(91, 110, 121);
    public static final int GREEN = Color.rgb(15, 118, 110);
    public static final int WARN = Color.rgb(180, 83, 9);
    public static final int ERROR = Color.rgb(185, 28, 28);
    private static final int PAGE = Color.rgb(244, 248, 247);
    private static final int BORDER = Color.rgb(223, 234, 230);

    private Ui() {}

    public static int dp(android.content.Context context, int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                context.getResources().getDisplayMetrics()));
    }

    /** Root column inside a scroll view; pads for the system bars since Android 15 draws under them. */
    public static LinearLayout screen(Activity activity) {
        activity.getWindow().setStatusBarColor(PAGE);
        activity.getWindow().setNavigationBarColor(Color.WHITE);
        activity.getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(PAGE);
        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(activity, 20), dp(activity, 24), dp(activity, 20), dp(activity, 32));
        scroll.addView(root);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            root.setPadding(dp(activity, 20), dp(activity, 24) + insets.getSystemWindowInsetTop(),
                    dp(activity, 20), dp(activity, 32) + insets.getSystemWindowInsetBottom());
            return insets;
        });
        activity.setContentView(scroll);
        return root;
    }

    public static LinearLayout card(LinearLayout parent) {
        android.content.Context context = parent.getContext();
        LinearLayout box = new LinearLayout(context);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(context, 18), dp(context, 16), dp(context, 18), dp(context, 18));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.WHITE);
        background.setCornerRadius(dp(context, 18));
        background.setStroke(dp(context, 1), BORDER);
        box.setBackground(background);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(context, 16);
        parent.addView(box, params);
        return box;
    }

    public static TextView text(LinearLayout parent, String value, int size, int color, boolean bold) {
        TextView view = new TextView(parent.getContext());
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setLineSpacing(dp(parent.getContext(), 3), 1f);
        view.setPadding(0, dp(parent.getContext(), 5), 0, dp(parent.getContext(), 7));
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        parent.addView(view, new LinearLayout.LayoutParams(-1, -2));
        return view;
    }

    static Button button(LinearLayout parent, String label, boolean primary, Runnable action) {
        android.content.Context context = parent.getContext();
        Button view = new Button(context);
        view.setText(label);
        view.setAllCaps(false);
        view.setTextSize(16);
        view.setTextColor(primary ? Color.WHITE : GREEN);
        view.setBackgroundTintList(ColorStateList.valueOf(primary ? GREEN : Color.rgb(231, 243, 239)));
        view.setMinHeight(dp(context, 52));
        view.setOnClickListener(clicked -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(context, 8);
        parent.addView(view, params);
        return view;
    }
}
